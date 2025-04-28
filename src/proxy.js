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
  return url
    .replace(/https?:\/\/github\.com/g, `http://${host}`)
    .replace(/https?:\/\/api\.github\.com/g, `http://${host}/api`)
    .replace(/https?:\/\/raw\.githubusercontent\.com/g, `http://${host}/raw`)
    .replace(/https?:\/\/github-releases\.githubusercontent\.com/g, `http://${host}/releases`)
    .replace(/https?:\/\/github\.githubassets\.com/g, `http://${host}/assets`)
    .replace(/https?:\/\/codeload\.github\.com/g, `http://${host}/codeload`);
};

// 转换HTML内容中的链接
const transformHtmlContent = (body, req) => {
  if (!body || typeof body !== 'string') return body;
  
  const host = req.headers.host;
  
  // 添加Turbo警告抑制属性
  body = body.replace(/<body([^>]*)>/, '<body$1 data-turbo-suppress-warning>');
  
  // 移动Turbo脚本到head
  const turboScript = body.match(/<script[^>]*src="[^"]*turbo[^"]*"[^>]*><\/script>/);
  if (turboScript) {
    body = body.replace(turboScript[0], '');
    body = body.replace(/<\/head>/, `${turboScript[0]}</head>`);
  }
  
  // 处理include-fragment元素，转换src属性
  body = body.replace(/<include-fragment([^>]*)src="([^"]*)"([^>]*)>/g, (match, pre, src, post) => {
    // 如果是HTTP/HTTPS链接，转换为代理路径
    if (src.startsWith('http')) {
      // 提取有效的URL部分
      const urlMatch = src.match(/^(https?:\/\/[^"'\s]+)/);
      if (urlMatch) {
        return `<include-fragment${pre}src="/fragment/${urlMatch[1]}"${post}>`;
      }
    }
    
    // 相对路径保持不变
    return match;
  });
  
  // 修复资源地址访问问题，转换外部资源为代理路径
  body = body.replace(/(src|href)="(https?:\/\/cdn\.[^"]+)"/g, (match, attr, url) => {
    if (url.includes('/assets/') || url.includes('/images/') || 
        url.includes('.js') || url.includes('.css') || 
        url.includes('.png') || url.includes('.jpg') || 
        url.includes('.svg') || url.includes('.ico')) {
      return `${attr}="/fragment/${url}"`;
    }
    return match;
  });
  
  // 转换GitHub域名
  return body
    .replace(/https?:\/\/github\.com/g, `http://${host}`)
    .replace(/https?:\/\/api\.github\.com/g, `http://${host}/api`)
    .replace(/https?:\/\/raw\.githubusercontent\.com/g, `http://${host}/raw`)
    .replace(/https?:\/\/github-releases\.githubusercontent\.com/g, `http://${host}/releases`)
    .replace(/https?:\/\/github\.githubassets\.com/g, `http://${host}/assets`)
    .replace(/https?:\/\/codeload\.github\.com/g, `http://${host}/codeload`);
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
  
  try {
    // 将CSP头解析为指令对象
    const directives = {};
    
    // 分割CSP指令
    header.split(';').forEach(directive => {
      directive = directive.trim();
      if(!directive) return;
      
      const parts = directive.split(/\s+/);
      if(parts.length < 1) return;
      
      const directiveName = parts[0];
      const sources = parts.slice(1);
      
      directives[directiveName] = sources;
    });
    
    // 特殊处理frame-ancestors指令，如果包含'none'则移除其他所有源
    if(directives['frame-ancestors'] && directives['frame-ancestors'].includes("'none'")) {
      directives['frame-ancestors'] = ["'none'"];
    }
    
    // 添加代理主机到每个指令
    Object.keys(directives).forEach(directive => {
      if(directive === 'upgrade-insecure-requests') {
        // 删除此指令，因为我们使用HTTP
        delete directives[directive];
        return;
      }
      
      // 源集合，避免重复
      const sourceSet = new Set(directives[directive]);
      
      // 添加我们的主机
      if(directive !== 'report-uri' && directive !== 'report-to' && !sourceSet.has("'none'")) {
        sourceSet.add(host);
        
        if(directive === 'script-src' || directive === 'script-src-elem') {
          sourceSet.add("'unsafe-inline'");
          sourceSet.add("'unsafe-eval'");
        }
        
        if(directive === 'style-src' || directive === 'style-src-elem') {
          sourceSet.add("'unsafe-inline'");
        }
      }
      
      // 特殊处理：修复域名格式问题
      const cleanedSources = Array.from(sourceSet).map(source => {
        // 移除URL末尾的斜杠
        if(source && typeof source === 'string') {
          return source.replace(/\/+$/, '');
        }
        return source;
      });
      
      directives[directive] = cleanedSources;
    });
    
    // 重建CSP字符串
    const newCSP = Object.entries(directives)
      .map(([name, sources]) => `${name} ${sources.join(' ')}`)
      .join('; ');
    
    return newCSP;
  } catch(error) {
    console.error('处理CSP头时出错:', error.message);
    return header; // 出错时返回原始头
  }
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
  
  // 处理X-Frame-Options，允许在我们的代理中嵌入内容
  if(result['x-frame-options'] || result['X-Frame-Options']) {
    delete result['x-frame-options'];
    delete result['X-Frame-Options'];
  }
  
  // 添加必要的安全头
  result['X-Content-Type-Options'] = 'nosniff';
  result['X-XSS-Protection'] = '1; mode=block';
  result['Referrer-Policy'] = 'strict-origin-when-cross-origin';
  result['Permissions-Policy'] = 'interest-cohort=()';
  
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

// 处理include-fragment请求
const handleIncludeFragmentRequest = (req, res) => {
  const startTime = Date.now();
  const fragmentUrl = req.url.replace(/^\/fragment\//, '');
  
  // 支持多种域名的请求
  let targetUrl = fragmentUrl;
  if (!targetUrl.startsWith('http')) {
    // 处理相对路径，确保添加协议
    if (targetUrl.startsWith('cdn.')) {
      targetUrl = `https://${targetUrl}`;
    } else {
      targetUrl = `${config.github.baseUrl}${fragmentUrl}`;
    }
  }
  
  try {
    // 规范化URL，避免格式问题
    const urlObj = new URL(targetUrl);
    targetUrl = urlObj.toString();
    
    // 移除URL末尾的斜杠
    if (targetUrl.endsWith('/')) {
      targetUrl = targetUrl.slice(0, -1);
    }
    
    const targetHost = urlObj.host;
    
    console.log(`处理include-fragment请求: ${targetUrl}`);
    
    // 特殊处理expanded_assets路径
    if(targetUrl.includes('expanded_assets')) {
      // 修复缺少文件扩展名的问题
      if(!targetUrl.match(/\.[a-z0-9]+$/i)) {
        targetUrl = `${targetUrl}.json`;
      }
    }
    
    const cacheKey = `fragment:${targetUrl}`;
    
    getOrSetCache(cacheKey, config.cache.maxAge, () => 
      axiosClient.default.get(targetUrl, { 
        responseType: 'arraybuffer',
        headers: addRequiredHeaders({...req.headers, 'Accept': '*/*'}, targetHost),
        timeout: 15000,
        maxRedirects: 5
      })
    )
    .then(response => {
      if(res.headersSent) return;
      
      // 处理CORS头，确保允许跨域请求
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
      
      // 处理并发送其他响应头
      const processedHeaders = processResponseHeaders(response.headers, req);
      Object.entries(processedHeaders).forEach(([key, value]) => {
        if (key.toLowerCase() !== 'access-control-allow-origin' && 
            key.toLowerCase() !== 'access-control-allow-methods' && 
            key.toLowerCase() !== 'access-control-allow-headers' && 
            key !== 'transfer-encoding' && 
            key !== 'content-length') {
          res.setHeader(key, value);
        }
      });
      
      // 设置缓存控制头
      res.setHeader('Cache-Control', 'public, max-age=3600'); // 1小时缓存
      
      // 设置正确的内容类型
      const contentType = response.headers['content-type'] || 'application/octet-stream';
      res.setHeader('Content-Type', contentType);
      
      // 如果是HTML内容，转换链接
      if (contentType.includes('text/html')) {
        let html = response.data.toString('utf-8');
        html = transformHtmlContent(html, req);
        res.end(html);
      } else {
        res.end(response.data);
      }
      
      recordProxyRequest(req, startTime, response.status, extractRepoFromUrl(req.url));
    })
    .catch(error => {
      console.error('Fragment请求错误:', error.message);
      
      // 尝试不同的文件扩展名
      if(targetUrl.includes('expanded_assets') && !error.message.includes('retry')) {
        const extensions = ['.json', '.js', '.ts', '.css', '.txt', '.md'];
        let currentExtension = '';
        const baseUrl = targetUrl.replace(/\.[^/.]+$/, '');
        
        // 检查当前URL是否已有扩展名
        const match = targetUrl.match(/\.([^/.]+)$/);
        if(match) {
          currentExtension = match[1];
        }
        
        // 找出下一个要尝试的扩展名
        let nextExtIndex = 0;
        if(currentExtension) {
          const currentIndex = extensions.findIndex(ext => ext.substring(1) === currentExtension);
          nextExtIndex = currentIndex > -1 ? (currentIndex + 1) % extensions.length : 0;
        }
        
        const nextUrl = `${baseUrl}${extensions[nextExtIndex]}`;
        console.log(`尝试其他扩展名: ${nextUrl} (retry)`);
        
        axiosClient.default.get(nextUrl, {
          responseType: 'arraybuffer',
          headers: addRequiredHeaders({...req.headers, 'Accept': '*/*', 'User-Agent': `${req.headers['user-agent'] || getRandomUserAgent()} retry`}, targetHost),
          timeout: 15000,
          maxRedirects: 5
        })
        .then(response => {
          if(res.headersSent) return;
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.setHeader('Cache-Control', 'public, max-age=3600');
          res.setHeader('Content-Type', response.headers['content-type'] || 'application/octet-stream');
          res.statusCode = response.status;
          res.end(response.data);
          recordProxyRequest(req, startTime, response.status, extractRepoFromUrl(req.url));
        })
        .catch(() => {
          // 如果失败，尝试从GitHub获取
          tryGitHubFallback();
        });
      } else {
        // 直接尝试GitHub备用源
        tryGitHubFallback();
      }
      
      function tryGitHubFallback() {
        // 尝试从URL中提取仓库路径和文件信息
        const releaseMatch = targetUrl.match(/\/([^\/]+)\/([^\/]+)\/releases\/([^\/]+)\/([^\/]+)/);
        
        let githubFallbackUrl;
        if(releaseMatch) {
          const [_, owner, repo, releaseType, releaseInfo] = releaseMatch;
          if(releaseType === 'expanded_assets') {
            githubFallbackUrl = targetUrl.replace(/https?:\/\/cdn\.[^\/]+/, 'https://raw.githubusercontent.com')
              .replace('/expanded_assets/', '/download/');
          } else {
            githubFallbackUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${releaseType}/${releaseInfo}`;
          }
        } else {
          // 提取CDN路径
          const cdnPathMatch = targetUrl.match(/https?:\/\/cdn\.[^\/]+\/(.+)/);
          if(cdnPathMatch && cdnPathMatch[1]) {
            // 尝试构建GitHub路径
            githubFallbackUrl = `https://raw.githubusercontent.com/${cdnPathMatch[1]}`;
          } else {
            // 如果无法解析路径，直接替换域名
            githubFallbackUrl = targetUrl.replace(/https?:\/\/cdn\.[^\/]+/, 'https://raw.githubusercontent.com');
          }
        }
        
        console.log(`尝试GitHub备用源: ${githubFallbackUrl}`);
        
        axiosClient.default.get(githubFallbackUrl, {
          responseType: 'arraybuffer',
          headers: addRequiredHeaders({...req.headers, 'Accept': '*/*'}, new URL(githubFallbackUrl).host),
          timeout: 15000,
          maxRedirects: 5
        })
        .then(fallbackResponse => {
          if(res.headersSent) return;
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.setHeader('Cache-Control', 'public, max-age=3600');
          res.statusCode = fallbackResponse.status;
          res.end(fallbackResponse.data);
          recordProxyRequest(req, startTime, fallbackResponse.status, extractRepoFromUrl(req.url));
        })
        .catch(fallbackError => {
          console.error('GitHub备用请求错误:', fallbackError.message);
          handleError(fallbackError, req, res);
          recordProxyRequest(req, startTime, 404, extractRepoFromUrl(req.url));
        });
      }
    });
  } catch (error) {
    console.error(`无效的URL: ${targetUrl}`, error.message);
    handleError({ message: `无效的URL: ${targetUrl}` }, req, res);
    recordProxyRequest(req, startTime, 400, null);
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
    } else if (req.url.startsWith('/fragment/')) {
      handleIncludeFragmentRequest(req, res);
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