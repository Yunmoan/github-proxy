const axios = require('axios');
const httpProxy = require('http-proxy');
const fs = require('fs');
const path = require('path');
const config = require('../config/config');
const { URL } = require('url');
const cacheManager = require('./cache');
const admin = require('./admin');
const { handleAdminRequest } = require('./admin');
const { handleError, serveCustomErrorPage, safeStringify } = require('./errorHandler');
const axiosClient = require('./axiosClient');
const { shouldBlockPath, extractRepoPath, isRepoBlacklisted, createBlockedResponse } = require('./blacklist');
const adminApi = require('./adminApi');

// 设置axios默认配置
axios.defaults.timeout = 30000; // 30秒超时
axios.defaults.maxContentLength = 50 * 1024 * 1024; // 50MB
axios.defaults.maxRedirects = 5; // 最大重定向次数

// 创建代理实例
const proxy = httpProxy.createProxyServer({
  changeOrigin: true,
  selfHandleResponse: true,
  timeout: 60000, // 60秒超时
  proxyTimeout: 60000, // 添加代理超时设置
  socketTimeout: 90000 // 添加socket超时设置
});

// 设置代理错误处理
proxy.on('error', (err, req, res) => {
  console.error('代理服务器错误:', err.message);
  handleError(err, req, res);
  recordProxyRequest(req.url, false);
});

// 常用User-Agent列表，随机选择以避免被封
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/106.0.0.0 Safari/537.36 GithubProxy/1.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/106.0.0.0 Safari/537.36 GithubProxy/1.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/106.0.0.0 Safari/537.36 GithubProxy/1.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Edge/106.0.1370.47 Safari/537.36 GithubProxy/1.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:106.0) Gecko/20100101 Firefox/106.0 GithubProxy/1.0'
];

// 获取随机User-Agent
const getRandomUserAgent = () => {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
};

// 为请求添加必要的头信息(UA等)
const addRequiredHeaders = (headers, targetHost) => {
  const result = {...headers};
  
  // 确保有User-Agent
  if(!result['user-agent'] && !result['User-Agent']) {
    result['User-Agent'] = getRandomUserAgent();
  }
  
  // 设置主机头
  if(targetHost) {
    result.host = targetHost;
  }
  
  // 添加Accept头
  if(!result['accept'] && !result['Accept']) {
    result['Accept'] = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8';
  }
  
  // 添加编码头
  if(!result['accept-encoding'] && !result['Accept-Encoding']) {
    result['Accept-Encoding'] = 'gzip, deflate, br';
  }
  
  return result;
};

// 转换URL中的GitHub域名为目标域名
const transformGithubUrl = (url, req) => {
  if (!url) return url;
  
  const host = req.headers.host;
  const protocol = req.headers['x-forwarded-proto'] || 'http';
  return url
    .replace(/https?:\/\/github\.com/g, `${protocol}://${host}`)
    .replace(/https?:\/\/api\.github\.com/g, `${protocol}://${host}/api`)
    .replace(/https?:\/\/raw\.githubusercontent\.com/g, `${protocol}://${host}/raw`)
    .replace(/https?:\/\/github-releases\.githubusercontent\.com/g, `${protocol}://${host}/releases`)
    .replace(/https?:\/\/github\.githubassets\.com/g, `${protocol}://${host}/assets`)
    .replace(/https?:\/\/codeload\.github\.com/g, `${protocol}://${host}/codeload`);
};

// 转换HTML内容中的链接
const transformHtmlContent = (body, req) => {
  if (!body || typeof body !== 'string') return body;
  
  const protocol = req.headers['x-forwarded-proto'] || 'http';
  return body
    .replace(/https?:\/\/github\.com/g, `${protocol}://${req.headers.host}`)
    .replace(/https?:\/\/api\.github\.com/g, `${protocol}://${req.headers.host}/api`)
    .replace(/https?:\/\/raw\.githubusercontent\.com/g, `${protocol}://${req.headers.host}/raw`)
    .replace(/https?:\/\/github-releases\.githubusercontent\.com/g, `${protocol}://${req.headers.host}/releases`)
    .replace(/https?:\/\/github\.githubassets\.com/g, `${protocol}://${req.headers.host}/assets`)
    .replace(/https?:\/\/codeload\.github\.com/g, `${protocol}://${req.headers.host}/codeload`);
};

// 处理自定义页面
const serveCustomPage = (pagePath, res, statusCode = 200) => {
  return serveCustomErrorPage(pagePath, res, statusCode);
};

// 从缓存获取响应或设置缓存
const getOrSetCache = (cacheKey, maxAge, fetchCallback) => {
  const cached = cacheManager.get(cacheKey);
  if (cached) return Promise.resolve(cached);
  
  return fetchCallback().then(data => {
    cacheManager.set(cacheKey, data, maxAge);
    return data;
  });
};

// 处理内容安全策略(CSP)头
const processCSPHeader = (header, req) => {
  if(!header) return header;
  
  const host = req.headers.host;
  
  // 修改CSP策略，将我们的代理域名添加到各个指令中
  return header.replace(/github\.githubassets\.com/g, `github.githubassets.com ${host}`)
               .replace(/github\.com/g, `github.com ${host}`)
               .replace(/githubusercontent\.com/g, `githubusercontent.com ${host}`)
               .replace(/script-src\s/g, `script-src 'unsafe-inline' 'unsafe-eval' ${host} `)
               .replace(/style-src\s/g, `style-src 'unsafe-inline' ${host} `)
               .replace(/img-src\s/g, `img-src 'self' data: blob: ${host} `);
};

// 处理响应头，添加或修改CSP相关头部
const processResponseHeaders = (headers, req) => {
  const result = {...headers};
  
  // 处理各种CSP相关头部
  if(result['content-security-policy']) {
    result['content-security-policy'] = processCSPHeader(result['content-security-policy'], req);
  }
  
  if(result['Content-Security-Policy']) {
    result['Content-Security-Policy'] = processCSPHeader(result['Content-Security-Policy'], req);
  }
  
  // 处理CSP报告模式头部
  if(result['content-security-policy-report-only']) {
    result['content-security-policy-report-only'] = processCSPHeader(result['content-security-policy-report-only'], req);
  }
  
  if(result['Content-Security-Policy-Report-Only']) {
    result['Content-Security-Policy-Report-Only'] = processCSPHeader(result['Content-Security-Policy-Report-Only'], req);
  }
  
  // 处理X-Frame-Options，允许在我们的代理中嵌入内容
  if(result['x-frame-options'] || result['X-Frame-Options']) {
    delete result['x-frame-options'];
    delete result['X-Frame-Options'];
  }
  
  return result;
};

// 从API路径中提取仓库信息
const extractRepoFromApiUrl = (url) => {
  if (!url.startsWith('/api/')) return null;
  
  // 排除私有API路径
  if (url.includes('/_private')) return null;
  
  // 尝试匹配 /api/repos/{owner}/{repo} 模式
  const repoMatch = url.match(/^\/api\/repos\/([^\/]+)\/([^\/]+)/);
  if (repoMatch) {
    return `${repoMatch[1]}/${repoMatch[2]}`.toLowerCase();
  }
  
  // 尝试匹配其他API路径里的仓库信息
  const otherMatch = url.match(/\/([^\/]+)\/([^\/]+)\/(?:issues|pulls|branches|tags|releases|commits|contents)/);
  if (otherMatch) {
    return `${otherMatch[1]}/${otherMatch[2]}`.toLowerCase();
  }
  
  return null;
};

// 从raw路径中提取仓库信息
const extractRepoFromRawUrl = (url) => {
  if (!url.startsWith('/raw/')) return null;
  
  const parts = url.replace(/^\/raw\//, '').split('/');
  if (parts.length >= 2) {
    return `${parts[0]}/${parts[1]}`.toLowerCase();
  }
  
  return null;
};

// 检查是否应该阻止特定请求
const shouldBlockRequest = (req) => {
  const url = req.url;
  
  // 基本路径检查
  if (shouldBlockPath(url)) return true;
  
  // API路径特殊检查
  if (url.startsWith('/api/')) {
    const repoPath = extractRepoFromApiUrl(url);
    if (repoPath && isRepoBlacklisted(repoPath)) return true;
  }
  
  // Raw内容检查
  if (url.startsWith('/raw/')) {
    const repoPath = extractRepoFromRawUrl(url);
    if (repoPath && isRepoBlacklisted(repoPath)) return true;
  }
  
  // 其他子路径检查可以在这里添加
  
  return false;
};

// 发送阻止访问的响应
const sendBlockedResponse = (res, req) => {
  const blockedResponse = createBlockedResponse();
  res.writeHead(blockedResponse.statusCode, blockedResponse.headers);
  res.end(blockedResponse.body);
  
  // 记录日志
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  console.log(`[${new Date().toISOString()}] 阻止访问: ${req.url} (${clientIp})`);
};

// 提取GitHub请求中的仓库路径
const extractRepoFromUrl = (url) => {
  // 匹配形如 /owner/repo 的路径
  const match = url.match(/\/([^\/]+\/[^\/]+)(\/|$)/);
  if (match && match[1]) {
    const repoPath = match[1];
    // 排除非仓库路径，如 /assets/js 或 /admin/api 或 api/_private
    if (!repoPath.includes('.') && 
        !repoPath.includes('admin') && 
        !repoPath.includes('_private') && 
        repoPath.includes('/')) {
      return repoPath;
    }
  }
  return null;
};

// 记录代理请求
const recordProxyRequest = (req, startTime, statusCode, repository = '') => {
  const responseTime = Date.now() - startTime;
  
  // 初始化全局性能数据对象（如果不存在）
  if (!global.performanceData) {
    global.performanceData = {
      startTime: Date.now(),
      requestsProcessed: 0,
      totalResponseTime: 0,
      averageResponseTime: 0,
      slowRequests: [],
      errors: 0,
      pathStats: {},
      repositoryStats: {}
    };
  }

  // 更新全局计数器
  global.performanceData.requestsProcessed++;
  global.performanceData.totalResponseTime += responseTime;
  global.performanceData.averageResponseTime = 
    global.performanceData.totalResponseTime / global.performanceData.requestsProcessed;

  // 如果状态码表示错误（400以上），计入错误统计
  if (statusCode >= 400) {
    global.performanceData.errors++;
  }

  // 记录路径统计
  const path = req.url.split('?')[0]; // 移除查询参数
  if (!global.performanceData.pathStats[path]) {
    global.performanceData.pathStats[path] = {
      count: 0,
      totalResponseTime: 0,
      averageResponseTime: 0
    };
  }
  
  global.performanceData.pathStats[path].count++;
  global.performanceData.pathStats[path].totalResponseTime += responseTime;
  global.performanceData.pathStats[path].averageResponseTime = 
    global.performanceData.pathStats[path].totalResponseTime / global.performanceData.pathStats[path].count;
  
  // 更新慢请求列表
  if (responseTime > 500 || global.performanceData.slowRequests.length < 10) {
    const slowRequest = {
      path: req.url,
      responseTime,
      timestamp: new Date().toISOString(),
      statusCode
    };
    
    global.performanceData.slowRequests.push(slowRequest);
    global.performanceData.slowRequests.sort((a, b) => b.responseTime - a.responseTime);
    
    // 保持列表在限定大小内
    if (global.performanceData.slowRequests.length > 10) {
      global.performanceData.slowRequests.pop();
    }
  }
  
  // 记录仓库统计（如果提供了仓库信息）
  if (repository && repository.includes('/')) {
    if (!global.performanceData.repositoryStats[repository]) {
      global.performanceData.repositoryStats[repository] = {
        requestsCount: 0,
        totalResponseTime: 0,
        averageResponseTime: 0
      };
    }
    
    global.performanceData.repositoryStats[repository].requestsCount++;
    global.performanceData.repositoryStats[repository].totalResponseTime += responseTime;
    global.performanceData.repositoryStats[repository].averageResponseTime = 
      global.performanceData.repositoryStats[repository].totalResponseTime / 
      global.performanceData.repositoryStats[repository].requestsCount;
  }
};

// 处理GitHub API请求
const handleApiRequest = async (req, res) => {
  const startTime = Date.now();
  const targetPath = req.url.replace(/^\/api/, '');
  const targetUrl = `${config.github.apiUrl}${targetPath}`;
  const targetHost = new URL(config.github.apiUrl).host;
  
  // 构建请求选项
  const options = {
    url: targetUrl,
    method: req.method,
    headers: addRequiredHeaders({...req.headers}, targetHost),
    responseType: 'arraybuffer',
    validateStatus: status => status < 500 // 允许400等错误自行处理
  };
  
  // 处理请求体
  if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      if (body) options.data = body;
      makeRequest();
    });
  } else {
    makeRequest();
  }
  
  function makeRequest() {
    const cacheKey = `api:${req.method}:${targetUrl}`;
    
    getOrSetCache(cacheKey, config.cache.maxAge, () => axiosClient.default(options))
      .then(response => {
        if(res.headersSent) return; // 确保没有发送过响应
        
        const contentType = response.headers['content-type'] || '';
        const isJson = contentType.includes('application/json');
        let body = response.data;
        
        if (isJson && Buffer.isBuffer(body)) {
          body = body.toString('utf-8');
          if (body) {
            try {
              const jsonBody = JSON.parse(body);
              body = safeStringify(jsonBody); // 使用安全的JSON序列化
            } catch (e) {
              console.error('JSON解析错误:', e.message);
              // 使用原始数据
            }
          }
        }
        
        // 处理并发送响应头
        const processedHeaders = processResponseHeaders(response.headers, req);
        Object.entries(processedHeaders).forEach(([key, value]) => {
          if (key !== 'transfer-encoding' && key !== 'content-length') {
            res.setHeader(key, value);
          }
        });
        
        res.statusCode = response.status;
        res.end(body);
        recordProxyRequest(req, startTime, response.status, extractRepoFromUrl(req.url));
      })
      .catch(error => {
        console.error('API代理错误:', error.message);
        handleError(error, req, res);
        recordProxyRequest(req, startTime, error.response?.status || 500, extractRepoFromUrl(req.url));
      });
  }
};

// 处理原始内容请求(raw.githubusercontent.com)
const handleRawRequest = (req, res) => {
  const startTime = Date.now();
  const targetPath = req.url.replace(/^\/raw/, '');
  const targetUrl = `${config.github.rawUrl}${targetPath}`;
  const targetHost = new URL(config.github.rawUrl).host;
  
  const cacheKey = `raw:${targetUrl}`;
  
  getOrSetCache(cacheKey, config.cache.staticMaxAge, () => 
    axiosClient.default.get(targetUrl, { 
      responseType: 'arraybuffer',
      headers: addRequiredHeaders({...req.headers}, targetHost)
    })
  )
  .then(response => {
    if(res.headersSent) return; // 确保没有发送过响应
    
    // 处理并发送响应头
    const processedHeaders = processResponseHeaders(response.headers, req);
    Object.entries(processedHeaders).forEach(([key, value]) => {
      if (key !== 'transfer-encoding' && key !== 'content-length') {
        res.setHeader(key, value);
      }
    });
    
    res.statusCode = response.status;
    res.end(response.data);
    recordProxyRequest(req, startTime, response.status, extractRepoFromUrl(req.url));
  })
  .catch(error => {
    console.error('Raw内容代理错误:', error.message);
    handleError(error, req, res);
    recordProxyRequest(req, startTime, error.response?.status || 500, extractRepoFromUrl(req.url));
  });
};

// 处理Release资源文件请求
const handleReleaseRequest = (req, res) => {
  const startTime = Date.now();
  try {
    const targetPath = req.url.replace(/^\/releases/, '');
    const targetUrl = `${config.github.releaseUrl}${targetPath}`;
    const targetHost = new URL(config.github.releaseUrl).host;
    
    // 大文件使用专门的client
    axiosClient.largeFile.get(targetUrl, { 
      responseType: 'stream',
      headers: addRequiredHeaders({...req.headers}, targetHost)
    })
    .then(response => {
      if(res.headersSent) return;
      
      // 处理并发送响应头
      const processedHeaders = processResponseHeaders(response.headers, req);
      Object.entries(processedHeaders).forEach(([key, value]) => {
        if (key !== 'transfer-encoding' && key !== 'content-length') {
          res.setHeader(key, value);
        }
      });
      
      res.statusCode = response.status;
      
      // 流式传输
      response.data.pipe(res);
      recordProxyRequest(req, startTime, response.status, extractRepoFromUrl(req.url));
    })
    .catch(error => {
      console.error('Release文件代理错误:', error.message);
      handleError(error, req, res);
      recordProxyRequest(req, startTime, error.response?.status || 500, extractRepoFromUrl(req.url));
    });
  } catch (error) {
    handleError(error, req, res);
    recordProxyRequest(req, startTime, 500, extractRepoFromUrl(req.url));
  }
};

// 处理GitHub资源请求(github.githubassets.com)
const handleAssetsRequest = (req, res) => {
  const startTime = Date.now();
  const targetPath = req.url.replace(/^\/assets/, '');
  const targetUrl = `${config.github.assetsUrl}${targetPath}`;
  const targetHost = new URL(config.github.assetsUrl).host;
  
  const cacheKey = `assets:${targetUrl}`;
  
  getOrSetCache(cacheKey, config.cache.staticMaxAge, () => 
    axiosClient.static.get(targetUrl, { 
      responseType: 'arraybuffer',
      headers: addRequiredHeaders({...req.headers}, targetHost),
      timeout: 10000, // 10秒超时
      maxRedirects: 5,
      validateStatus: status => status < 500 // 允许400等错误自行处理
    })
  )
  .then(response => {
    if(res.headersSent) return; // 确保没有发送过响应
    
    // 处理并发送响应头
    const processedHeaders = processResponseHeaders(response.headers, req);
    Object.entries(processedHeaders).forEach(([key, value]) => {
      if (key !== 'transfer-encoding' && key !== 'content-length') {
        res.setHeader(key, value);
      }
    });
    
    // 设置缓存控制头
    res.setHeader('Cache-Control', 'public, max-age=86400'); // 24小时缓存
    res.setHeader('Expires', new Date(Date.now() + 86400000).toUTCString());
    
    res.statusCode = response.status;
    res.end(response.data);
    recordProxyRequest(req, startTime, response.status, extractRepoFromUrl(req.url));
  })
  .catch(error => {
    console.error('资源代理错误:', error.message);
    // 如果是404错误，尝试从备用源获取
    if(error.response?.status === 404) {
      const fallbackUrl = targetUrl.replace('github.githubassets.com', 'raw.githubusercontent.com');
      axiosClient.static.get(fallbackUrl, {
        responseType: 'arraybuffer',
        headers: addRequiredHeaders({...req.headers}, targetHost),
        timeout: 10000,
        maxRedirects: 5
      })
      .then(response => {
        if(res.headersSent) return;
        res.statusCode = response.status;
        res.end(response.data);
        recordProxyRequest(req, startTime, response.status, extractRepoFromUrl(req.url));
      })
      .catch(fallbackError => {
        console.error('备用源获取失败:', fallbackError.message);
        handleError(fallbackError, req, res);
        recordProxyRequest(req, startTime, 500, extractRepoFromUrl(req.url));
      });
    } else {
    handleError(error, req, res);
    recordProxyRequest(req, startTime, 500, extractRepoFromUrl(req.url));
    }
  });
};

// 处理代码下载请求
const handleCodeloadRequest = (req, res) => {
  const startTime = Date.now();
  try {
    const targetPath = req.url.replace(/^\/codeload/, '');
    const targetUrl = `${config.github.codeloadUrl}${targetPath}`;
    const targetHost = new URL(config.github.codeloadUrl).host;
    
    // 大文件使用专门的client
    axiosClient.largeFile.get(targetUrl, { 
      responseType: 'stream',
      headers: addRequiredHeaders({...req.headers}, targetHost)
    })
    .then(response => {
      if(res.headersSent) return;
      
      // 处理并发送响应头
      const processedHeaders = processResponseHeaders(response.headers, req);
      Object.entries(processedHeaders).forEach(([key, value]) => {
        if (key !== 'transfer-encoding' && key !== 'content-length') {
          res.setHeader(key, value);
        }
      });
      
      res.statusCode = response.status;
      
      // 流式传输
      response.data.pipe(res);
      recordProxyRequest(req, startTime, response.status, extractRepoFromUrl(req.url));
    })
    .catch(error => {
      console.error('代码下载代理错误:', error.message);
      handleError(error, req, res);
      recordProxyRequest(req, startTime, error.response?.status || 500, extractRepoFromUrl(req.url));
    });
  } catch (error) {
    handleError(error, req, res);
    recordProxyRequest(req, startTime, 500, extractRepoFromUrl(req.url));
  }
};

// 处理GitHub请求
const handleGithubRequest = async (req, res) => {
  const startTime = Date.now();
  try {
    // 首页重定向到自定义主页
    if (req.url === '/' || req.url === '') {
      serveCustomPage(config.customPages.homePath, res);
      recordProxyRequest(req, startTime, 200, null);
      return;
    }
    
    // 处理非主页的请求
    const targetUrl = `${config.github.baseUrl}${req.url}`;
    const targetHost = new URL(config.github.baseUrl).host;
    
    const options = {
      url: targetUrl,
      method: req.method,
      headers: addRequiredHeaders({...req.headers}, targetHost),
      responseType: 'arraybuffer',
      validateStatus: status => true, // 允许任何状态码，包括404等错误
      maxRedirects: 5
    };
    
    // 处理POST等请求
    if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
      let body = '';
      req.on('data', chunk => { body += chunk.toString(); });
      req.on('end', () => {
        if (body) options.data = body;
        makeRequest();
      });
    } else {
      makeRequest();
    }

    function makeRequest() {
      const cacheKey = `github:${req.method}:${targetUrl}`;
      
      getOrSetCache(cacheKey, config.cache.maxAge, () => axiosClient.default(options))
        .then(response => {
          if(res.headersSent) return; // 确保没有发送过响应
          
          // 检查404状态，直接使用我们的自定义页面
          if(response.status === 404){
            console.log(`收到GitHub 404响应，使用自定义404页面: ${req.url}`);
            serveCustomErrorPage(config.customPages.notFoundPath, res, 404);
            recordProxyRequest(req, startTime, 404, null);
            return;
          }
          
          const contentType = response.headers['content-type'] || '';
          const isHtml = contentType.includes('text/html');
          let body = response.data;
          
          // 处理HTML内容，替换GitHub域名为我们的代理域名
          if (isHtml && body) {
            if (Buffer.isBuffer(body)) {
              body = body.toString('utf-8');
            }
            
            body = transformHtmlContent(body, req);
          }
          
          // 处理并发送响应头
          const processedHeaders = processResponseHeaders(response.headers, req);
          Object.entries(processedHeaders).forEach(([key, value]) => {
            if (key !== 'transfer-encoding' && key !== 'content-length') {
              // 替换Location头中的GitHub URL
              if (key.toLowerCase() === 'location') {
                res.setHeader(key, transformGithubUrl(value, req));
              } else {
                res.setHeader(key, value);
              }
            }
          });
          
          res.statusCode = response.status;
          res.end(Buffer.isBuffer(body) ? body : Buffer.from(body));
          recordProxyRequest(req, startTime, response.status, extractRepoFromUrl(req.url));
        })
        .catch(error => {
          console.error('GitHub代理错误:', error.message);
          
          // 如果是404错误，使用自定义404页面
          if(error.response && error.response.status === 404){
            console.log(`捕获到404错误，使用自定义404页面: ${req.url}`);
            serveCustomErrorPage(config.customPages.notFoundPath, res, 404);
            recordProxyRequest(req, startTime, 404, null);
            return;
          }
          
          handleError(error, req, res);
          recordProxyRequest(req, startTime, error.response?.status || 500, null);
        });
    }
  } catch (error) {
    handleError(error, req, res);
    recordProxyRequest(req, startTime, 500, null);
  }
};

// 根据请求路径选择相应的处理函数
const route = (req, res) => {
  try {
    // 检查黑名单
    if (shouldBlockRequest(req)) {
      sendBlockedResponse(res, req);
      recordProxyRequest(req, Date.now(), 403, null);
      return;
    }
  
    // 处理管理API请求
    if (req.url.startsWith('/admin/')) {
      handleAdminRequest(req, res);
      return;
    }
    
    if (req.url.startsWith('/api/')) {
      handleApiRequest(req, res);
    } else if (req.url.startsWith('/raw/')) {
      handleRawRequest(req, res);
    } else if (req.url.startsWith('/releases/')) {
      handleReleaseRequest(req, res);
    } else if (req.url.startsWith('/assets/')) {
      handleAssetsRequest(req, res);
    } else if (req.url.startsWith('/codeload/')) {
      handleCodeloadRequest(req, res);
    } else {
      handleGithubRequest(req, res);
    }
  } catch (error) {
    console.error('路由处理错误:', error);
    handleError(error, req, res);
    recordProxyRequest(req, Date.now(), 500, null);
  }
};

module.exports = { route };