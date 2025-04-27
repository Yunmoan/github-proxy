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
  timeout: 60000 // 60秒超时
});

// 设置代理错误处理
proxy.on('error', (err, req, res) => {
  console.error('代理服务器错误:', err.message);
  handleError(err, req, res);
  recordProxyRequest(req.url, false);
});

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
  
  return body
    .replace(/https?:\/\/github\.com/g, `http://${req.headers.host}`)
    .replace(/https?:\/\/api\.github\.com/g, `http://${req.headers.host}/api`)
    .replace(/https?:\/\/raw\.githubusercontent\.com/g, `http://${req.headers.host}/raw`)
    .replace(/https?:\/\/github-releases\.githubusercontent\.com/g, `http://${req.headers.host}/releases`)
    .replace(/https?:\/\/github\.githubassets\.com/g, `http://${req.headers.host}/assets`)
    .replace(/https?:\/\/codeload\.github\.com/g, `http://${req.headers.host}/codeload`);
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
               .replace(/style-src\s/g, `style-src 'unsafe-inline' ${host} `);
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
  
  return result;
};

// 从API路径中提取仓库信息
const extractRepoFromApiUrl = (url) => {
  if (!url.startsWith('/api/')) return null;
  
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
    // 排除非仓库路径，如 /assets/js 或 /admin/api
    if (!repoPath.includes('.') && !repoPath.includes('admin') && repoPath.includes('/')) {
      return repoPath;
    }
  }
  return null;
};

// 记录代理请求
const recordProxyRequest = (url, success, statusCode = 200, responseTime = 0) => {
  const repoPath = extractRepoFromUrl(url);
  
  // 调用管理模块的记录请求函数
  admin.recordRequest(url, success, statusCode, responseTime);
  
  // 记录到性能统计
  adminApi.recordPerformanceDataPoint(url || '', responseTime, statusCode, 0);
};

// 处理GitHub API请求
const handleApiRequest = async (req, res) => {
  const startTime = Date.now();
  const targetPath = req.url.replace(/^\/api/, '');
  const targetUrl = `${config.github.apiUrl}${targetPath}`;
  
  // 构建请求选项
  const options = {
    url: targetUrl,
    method: req.method,
    headers: {...req.headers, host: new URL(config.github.apiUrl).host},
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
        recordProxyRequest(req.url, true);
        
        // 记录性能数据
        const responseTime = Date.now() - startTime;
        const originalUrl = req.url;
        
        // 获取响应大小，避免使用JSON.stringify
        const responseSize = Buffer.isBuffer(body) ? body.length : Buffer.byteLength(body || '');
        
        // 记录性能数据点
        adminApi.recordPerformanceDataPoint(originalUrl, responseTime, response.status, responseSize);
        
        // 从URL中提取仓库信息
        const repoPath = extractRepoFromUrl(originalUrl);
        if (repoPath) {
          console.log(`记录仓库访问: ${repoPath}`);
          // 单独记录仓库统计
          const repoUrl = `/${repoPath}`;
          adminApi.recordPerformanceDataPoint(repoUrl, responseTime, response.status, 0);
        }
      })
      .catch(error => {
        console.error('API代理错误:', error.message);
        handleError(error, req, res);
        recordProxyRequest(req.url, false);
        
        // 记录错误性能数据
        const responseTime = Date.now() - startTime;
        const statusCode = error.response?.status || 500;
        adminApi.recordPerformanceDataPoint(originalUrl, responseTime, statusCode, 0);
      });
  }
};

// 处理原始内容请求(raw.githubusercontent.com)
const handleRawRequest = (req, res) => {
  const startTime = Date.now();
  const targetPath = req.url.replace(/^\/raw/, '');
  const targetUrl = `${config.github.rawUrl}${targetPath}`;
  
  const cacheKey = `raw:${targetUrl}`;
  
  getOrSetCache(cacheKey, config.cache.staticMaxAge, () => 
    axiosClient.default.get(targetUrl, { responseType: 'arraybuffer' })
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
    recordProxyRequest(req.url, true);
    
    // 记录性能数据
    const responseTime = Date.now() - startTime;
    const originalUrl = req.url;
    
    // 获取响应大小，避免使用JSON.stringify
    const responseSize = Buffer.isBuffer(response.data) ? response.data.length : 0;
    
    // 记录性能数据点
    adminApi.recordPerformanceDataPoint(originalUrl, responseTime, response.status, responseSize);
    
    // 从URL中提取仓库信息
    const repoPath = extractRepoFromUrl(originalUrl);
    if (repoPath) {
      console.log(`记录仓库访问: ${repoPath}`);
      // 单独记录仓库统计
      const repoUrl = `/${repoPath}`;
      adminApi.recordPerformanceDataPoint(repoUrl, responseTime, response.status, 0);
    }
  })
  .catch(error => {
    console.error('Raw内容代理错误:', error.message);
    handleError(error, req, res);
    recordProxyRequest(req.url, false);
    
    // 记录错误性能数据
    const responseTime = Date.now() - startTime;
    const statusCode = error.response?.status || 500;
    adminApi.recordPerformanceDataPoint(req.url, responseTime, statusCode, 0);
  });
};

// 处理Release资源文件请求
const handleReleaseRequest = (req, res) => {
  const startTime = Date.now();
  try {
    const targetPath = req.url.replace(/^\/releases/, '');
    const targetUrl = `${config.github.releaseUrl}${targetPath}`;
    
    // 大文件使用专门的client
    axiosClient.largeFile.get(targetUrl, { 
      responseType: 'stream',
      headers: {...req.headers, host: new URL(config.github.releaseUrl).host}
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
      recordProxyRequest(req.url, true);
      
      // 记录性能数据
      const responseTime = Date.now() - startTime;
      const originalUrl = req.url;
      
      // 记录性能数据点
      adminApi.recordPerformanceDataPoint(originalUrl, responseTime, response.status, 0);
      
      // 从URL中提取仓库信息
      const repoPath = extractRepoFromUrl(originalUrl);
      if (repoPath && repoPath.includes('/')) {
        console.log(`记录仓库访问: ${repoPath}`);
        // 单独记录仓库统计
        const repoUrl = `/${repoPath}`;
        adminApi.recordPerformanceDataPoint(repoUrl, responseTime, response.status, 0);
      }
    })
    .catch(error => {
      console.error('Release文件代理错误:', error.message);
      handleError(error, req, res);
      recordProxyRequest(req.url, false);
      
      // 记录错误性能数据
      const responseTime = Date.now() - startTime;
      const statusCode = error.response?.status || 500;
      adminApi.recordPerformanceDataPoint(req.url, responseTime, statusCode, 0);
    });
  } catch (error) {
    handleError(error, req, res);
    recordProxyRequest(req.url, false);
    
    // 记录严重错误性能数据
    const responseTime = Date.now() - startTime;
    adminApi.recordPerformanceDataPoint(req.url, responseTime, 500, 0);
  }
};

// 处理GitHub资源请求(github.githubassets.com)
const handleAssetsRequest = (req, res) => {
  const startTime = Date.now();
  const targetPath = req.url.replace(/^\/assets/, '');
  const targetUrl = `${config.github.assetsUrl}${targetPath}`;
  
  const cacheKey = `assets:${targetUrl}`;
  
  getOrSetCache(cacheKey, config.cache.staticMaxAge, () => 
    axiosClient.static.get(targetUrl, { responseType: 'arraybuffer' })
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
    recordProxyRequest(req.url, true);
    
    // 记录性能数据
    const responseTime = Date.now() - startTime;
    const originalUrl = req.url;
    adminApi.recordPerformanceDataPoint(originalUrl, responseTime, response.status, Buffer.byteLength(JSON.stringify(response.data) || ''));
  })
  .catch(error => {
    console.error('资源代理错误:', error.message);
    handleError(error, req, res);
    recordProxyRequest(req.url, false);
    
    // 记录严重错误性能数据
    const responseTime = Date.now() - startTime;
    adminApi.recordPerformanceDataPoint(req.url, responseTime, 500, 0);
  });
};

// 处理代码下载请求
const handleCodeloadRequest = (req, res) => {
  const startTime = Date.now();
  try {
    const targetPath = req.url.replace(/^\/codeload/, '');
    const targetUrl = `${config.github.codeloadUrl}${targetPath}`;
    
    // 大文件使用专门的client
    axiosClient.largeFile.get(targetUrl, { 
      responseType: 'stream',
      headers: {...req.headers, host: new URL(config.github.codeloadUrl).host}
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
      recordProxyRequest(req.url, true);
      
      // 记录性能数据
      const responseTime = Date.now() - startTime;
      const originalUrl = req.url;
      adminApi.recordPerformanceDataPoint(originalUrl, responseTime, response.status, Buffer.byteLength(JSON.stringify(response.data) || ''));
    })
    .catch(error => {
      console.error('代码下载代理错误:', error.message);
      handleError(error, req, res);
      recordProxyRequest(req.url, false);
      
      // 记录错误性能数据
      const responseTime = Date.now() - startTime;
      const statusCode = error.response?.status || 500;
      adminApi.recordPerformanceDataPoint(req.url, responseTime, statusCode, 0);
    });
  } catch (error) {
    handleError(error, req, res);
    recordProxyRequest(req.url, false);
    
    // 记录严重错误性能数据
    const responseTime = Date.now() - startTime;
    adminApi.recordPerformanceDataPoint(req.url, responseTime, 500, 0);
  }
};

// 处理GitHub请求
const handleGithubRequest = async (req, res) => {
  const startTime = Date.now();
  try {
    // 首页重定向到自定义主页
    if (req.url === '/' || req.url === '') {
      serveCustomPage(config.customPages.homePath, res);
      recordProxyRequest(req.url, true);
      return;
    }
    
    // 处理非主页的请求
    const targetUrl = `${config.github.baseUrl}${req.url}`;
    const options = {
      url: targetUrl,
      method: req.method,
      headers: {...req.headers, host: new URL(config.github.baseUrl).host},
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
            recordProxyRequest(req.url, false);
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
          recordProxyRequest(req.url, true);
          
          // 记录性能数据
          const responseTime = Date.now() - startTime;
          const originalUrl = req.url;
          
          // 获取响应大小，避免使用JSON.stringify
          const responseSize = Buffer.isBuffer(body) ? body.length : Buffer.byteLength(body || '');
          
          // 记录性能数据点
          adminApi.recordPerformanceDataPoint(originalUrl, responseTime, response.status, responseSize);
          
          // 从URL中提取仓库信息
          const repoPath = extractRepoFromUrl(originalUrl);
          if (repoPath) {
            console.log(`记录仓库访问: ${repoPath}`);
            // 单独记录仓库统计
            const repoUrl = `/${repoPath}`;
            adminApi.recordPerformanceDataPoint(repoUrl, responseTime, response.status, 0);
          }
        })
        .catch(error => {
          console.error('GitHub代理错误:', error.message);
          
          // 如果是404错误，使用自定义404页面
          if(error.response && error.response.status === 404){
            console.log(`捕获到404错误，使用自定义404页面: ${req.url}`);
            serveCustomErrorPage(config.customPages.notFoundPath, res, 404);
            recordProxyRequest(req.url, false);
            return;
          }
          
          handleError(error, req, res);
          recordProxyRequest(req.url, false);
          
          // 记录错误性能数据
          const responseTime = Date.now() - startTime;
          const statusCode = error.response?.status || 500;
          adminApi.recordPerformanceDataPoint(req.url, responseTime, statusCode, 0);
        });
    }
  } catch (error) {
    handleError(error, req, res);
    recordProxyRequest(req.url, false);
    
    // 记录严重错误性能数据
    const responseTime = Date.now() - startTime;
    adminApi.recordPerformanceDataPoint(req.url, responseTime, 500, 0);
  }
};

// 根据请求路径选择相应的处理函数
const route = (req, res) => {
  try {
    // 检查黑名单
    if (shouldBlockRequest(req)) {
      sendBlockedResponse(res, req);
      recordProxyRequest(req.url, false);
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
    recordProxyRequest(req.url, false);
  }
};

module.exports = { route }; 