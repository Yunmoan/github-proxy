const http = require('http');
const fs = require('fs');
const path = require('path');
const config = require('../config/config');
const { route } = require('./proxy');
const { handleError, serveCustomErrorPage } = require('./errorHandler');
const { blockBlacklistedContent } = require('./blacklist');
const admin = require('./admin'); // 导入admin模块
const axios = require('axios');
const events = require('events'); // 导入events模块

// 增加默认最大监听器数量，避免内存泄漏警告
events.defaultMaxListeners = 20;

// 请求超时设置
const REQUEST_TIMEOUT = 3 * 60 * 1000; // 3分钟

// 创建HTTP服务器
const server = http.createServer((req, res) => {
  // 捕获整个请求处理过程中的异常
  try {
    // 处理OPTIONS请求（CORS预检请求）
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE');
      res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With,content-type,Authorization');
      res.setHeader('Access-Control-Max-Age', '86400'); // 24小时缓存预检请求
      res.statusCode = 204; // No Content
      res.end();
      return;
    }
    
    // 设置请求超时
    req.setTimeout(REQUEST_TIMEOUT);
    res.setTimeout(REQUEST_TIMEOUT);
    
    // 为所有请求添加错误处理
    req.on('error', (err) => {
      console.error('请求错误:', err.message);
      handleError(err, req, res);
    });
    
    res.on('error', (err) => {
      console.error('响应错误:', err.message);
      // 如果响应头尚未发送，尝试发送错误响应
      if (!res.headersSent) {
        handleError(err, req, res);
      }
    });
    
    // 处理超时
    req.on('timeout', () => {
      console.error('请求超时:', req.url);
      handleError({ message: '请求处理超时', code: 'TIMEOUT', status: 504 }, req, res);
    });
    
    res.on('timeout', () => {
      console.error('响应超时:', req.url);
      if (!res.headersSent) {
        handleError({ message: '响应发送超时', code: 'TIMEOUT', status: 504 }, req, res);
      }
    });
    
    // 主请求处理结束后处理连接关闭
    req.on('close', () => {
      // 如果请求过早关闭，记录日志但不做额外处理
      if(!res.writableEnded && !res.writableFinished) {
        console.log(`客户端过早关闭连接: ${req.url}`);
      }
    });
    
    // 添加Socket错误监听，使用Symbol标记是否已添加监听器
    if(!req.socket._errorHandlerAdded) {
      req.socket._errorHandlerAdded = true;
      req.socket.on('error', (err) => {
        console.error(`Socket错误(${req.socket.remoteAddress}): ${err.message}`);
        // 不需要做额外处理，http.Server会自动处理socket错误
      });
    }
    
    // 如果是静态文件请求且文件不存在，直接返回404
    if(req.url.match(/\.(html|js|css|jpg|jpeg|png|gif|ico|svg|woff|woff2|ttf|eot)$/i)) {
      // 特殊处理favicon.ico
      if(req.url === '/favicon.ico') {
        const faviconPath = path.join(process.cwd(), 'public', 'favicon.ico');
        if(fs.existsSync(faviconPath)) {
          res.setHeader('Content-Type', 'image/x-icon');
          res.setHeader('Cache-Control', 'public, max-age=86400');
          fs.createReadStream(faviconPath).pipe(res);
          return;
        } else {
          // 从GitHub获取默认favicon
          axios.get('https://github.githubassets.com/favicon.ico', {
            responseType: 'arraybuffer',
            timeout: 5000
          })
          .then(response => {
            if(res.headersSent) return;
            res.setHeader('Content-Type', 'image/x-icon');
            res.setHeader('Cache-Control', 'public, max-age=86400');
            res.statusCode = response.status;
            res.end(response.data);
          })
          .catch(error => {
            console.error('获取favicon失败:', error.message);
            res.statusCode = 404;
            res.end();
          });
          return;
        }
      }
      
      // 检查是否是CDN资源请求
      if(req.url.includes('cdn.')) {
        // 提取完整的CDN URL
        let cdnUrl;
        let cdnPath = '';
        
        if(req.url.includes('http')) {
          // URL中包含完整的CDN地址
          const match = req.url.match(/https?:\/\/(cdn\.[^"'\s]*)/);
          if(match && match[1]) {
            cdnUrl = `https://${match[1]}`;
            
            // 规范化CDN URL格式
            cdnUrl = cdnUrl.replace(/([^:])\/\/+/g, '$1/'); // 移除多余的斜杠
            cdnUrl = cdnUrl.replace(/\/$/, ''); // 移除URL末尾的斜杠
          }
        } else {
          // 从请求路径中提取CDN域名和路径
          const cdnMatch = req.url.match(/\/fragment\/(cdn\.[^\/]+)(.*)/);
          if(cdnMatch) {
            const cdnDomain = cdnMatch[1];
            cdnPath = cdnMatch[2] || '';
            
            // 规范化路径格式
            if(cdnPath && !cdnPath.startsWith('/')) {
              cdnPath = '/' + cdnPath;
            }
            
            cdnUrl = `https://${cdnDomain}${cdnPath}`;
          }
        }
        
        if(!cdnUrl) {
          console.error('无法解析CDN URL:', req.url);
          serveCustomErrorPage(config.customPages.notFoundPath, res, 404);
          return;
        }
        
        console.log(`处理CDN请求: ${cdnUrl}`);
        
        // 根据文件扩展名判断内容类型
        const fileExtension = cdnUrl.split('.').pop().toLowerCase();
        const contentTypeMap = {
          'js': 'application/javascript',
          'mjs': 'application/javascript',
          'css': 'text/css',
          'json': 'application/json',
          'html': 'text/html',
          'htm': 'text/html',
          'svg': 'image/svg+xml',
          'png': 'image/png',
          'jpg': 'image/jpeg',
          'jpeg': 'image/jpeg',
          'gif': 'image/gif',
          'ico': 'image/x-icon',
          'woff': 'font/woff',
          'woff2': 'font/woff2',
          'ttf': 'font/ttf',
          'otf': 'font/otf',
          'eot': 'application/vnd.ms-fontobject'
        };
        
        // 设置预期的内容类型
        let expectedContentType = 'application/octet-stream';
        if(contentTypeMap[fileExtension]) {
          expectedContentType = contentTypeMap[fileExtension];
        }
        
        // 特殊处理expanded_assets路径
        if(cdnUrl.includes('expanded_assets')) {
          // 修复缺少文件扩展名的问题
          if(!cdnUrl.match(/\.[a-z0-9]+$/i)) {
            cdnUrl = `${cdnUrl}.json`;
            expectedContentType = 'application/json';
          }
        }
        
        // 添加URL查询参数
        const urlObj = new URL(cdnUrl);
        urlObj.searchParams.append('_proxy', 'true'); // 标记这是代理请求
        
        // 设置合适的请求头
        const headers = {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/111.0.0.0 Safari/537.36',
          'Accept': '*/*',
          'Accept-Encoding': 'gzip, deflate, br',
          'Referer': `https://${req.headers.host}/`,
          'Origin': `https://${req.headers.host}`,
          'Connection': 'keep-alive',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache'
        };
        
        // 发送请求
        axios.get(urlObj.toString(), {
          responseType: 'arraybuffer',
          timeout: 15000,
          maxRedirects: 5,
          headers: headers
        })
        .then(response => {
          if(res.headersSent) return;
          
          // 处理CORS头，确保允许跨域请求
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
          res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
          
          // 设置缓存控制头
          res.setHeader('Cache-Control', 'public, max-age=3600'); // 1小时缓存
          
          // 优先使用实际响应的Content-Type
          const contentType = response.headers['content-type'] || expectedContentType;
          res.setHeader('Content-Type', contentType);
          
          // 其他有用的响应头
          if(response.headers['last-modified']) {
            res.setHeader('Last-Modified', response.headers['last-modified']);
          }
          
          if(response.headers['etag']) {
            res.setHeader('ETag', response.headers['etag']);
          }
          
          res.statusCode = response.status;
          
          // 检查是否是HTML并处理链接
          if(contentType.includes('text/html')) {
            try {
              // 转换HTML中的链接
              const html = Buffer.isBuffer(response.data) ? response.data.toString('utf-8') : response.data;
              const processedHtml = require('./proxy').transformHtmlContent(html, req);
              res.end(processedHtml);
            } catch(error) {
              console.error('处理HTML内容错误:', error.message);
              res.end(response.data);
            }
          } else {
            res.end(response.data);
          }
        })
        .catch(error => {
          console.error('CDN请求错误:', error.message);
          
          // 尝试不同的文件扩展名
          if(cdnUrl.includes('expanded_assets') && !error.message.includes('retry')) {
            const extensions = ['.json', '.js', '.ts', '.css', '.txt', '.md'];
            let currentExtension = '';
            const baseUrl = cdnUrl.replace(/\.[^/.]+$/, '');
            
            // 检查当前URL是否已有扩展名
            const match = cdnUrl.match(/\.([^/.]+)$/);
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
            
            axios.get(nextUrl, {
              responseType: 'arraybuffer',
              timeout: 15000,
              maxRedirects: 5,
              headers: {
                ...headers,
                'User-Agent': `${headers['User-Agent']} retry`
              }
            })
            .then(response => {
              if(res.headersSent) return;
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.setHeader('Cache-Control', 'public, max-age=3600');
              
              // 基于扩展名设置内容类型
              const ext = nextUrl.split('.').pop().toLowerCase();
              const contentType = response.headers['content-type'] || (contentTypeMap[ext] || 'application/octet-stream');
              res.setHeader('Content-Type', contentType);
              
              res.statusCode = response.status;
              res.end(response.data);
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
            // 从URL中提取仓库路径和文件信息
            const releaseMatch = cdnUrl.match(/\/([^\/]+)\/([^\/]+)\/releases\/([^\/]+)\/([^\/]+)/);
            
            let githubFallbackUrl;
            if(releaseMatch) {
              const [_, owner, repo, releaseType, releaseInfo] = releaseMatch;
              if(releaseType === 'expanded_assets') {
                githubFallbackUrl = cdnUrl.replace(/https?:\/\/cdn\.[^\/]+/, 'https://raw.githubusercontent.com')
                  .replace('/expanded_assets/', '/download/');
              } else {
                githubFallbackUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${releaseType}/${releaseInfo}`;
              }
            } else {
              // 尝试构建GitHub路径
              try {
                const cdnPathMatch = cdnUrl.match(/https?:\/\/cdn\.[^\/]+\/(.+)/);
                if(cdnPathMatch && cdnPathMatch[1]) {
                  const pathParts = cdnPathMatch[1].split('/');
                  if(pathParts.length >= 2) {
                    const owner = pathParts[0];
                    const repo = pathParts[1];
                    const remainingPath = pathParts.slice(2).join('/');
                    githubFallbackUrl = `https://raw.githubusercontent.com/${owner}/${repo}/main/${remainingPath}`;
                  } else {
                    // 直接替换域名
                    githubFallbackUrl = cdnUrl.replace(/https?:\/\/cdn\.[^\/]+/, 'https://raw.githubusercontent.com');
                  }
                } else {
                  // 如果无法解析路径，直接替换域名
                  githubFallbackUrl = cdnUrl.replace(/https?:\/\/cdn\.[^\/]+/, 'https://raw.githubusercontent.com');
                }
              } catch(e) {
                // 解析错误，直接替换域名
                githubFallbackUrl = cdnUrl.replace(/https?:\/\/cdn\.[^\/]+/, 'https://raw.githubusercontent.com');
              }
            }
            
            console.log(`尝试GitHub备用源: ${githubFallbackUrl}`);
            
            axios.get(githubFallbackUrl, {
              responseType: 'arraybuffer',
              timeout: 15000,
              maxRedirects: 5,
              headers: {
                ...headers,
                'Host': new URL(githubFallbackUrl).host
              }
            })
            .then(fallbackResponse => {
              if(res.headersSent) return;
              res.setHeader('Access-Control-Allow-Origin', '*');
              res.setHeader('Cache-Control', 'public, max-age=3600');
              
              // 设置适当的内容类型
              const fileExt = githubFallbackUrl.split('.').pop().toLowerCase();
              const contentType = fallbackResponse.headers['content-type'] || 
                               (contentTypeMap[fileExt] || 'application/octet-stream');
              res.setHeader('Content-Type', contentType);
              
              res.statusCode = fallbackResponse.status;
              res.end(fallbackResponse.data);
            })
            .catch(fallbackError => {
              console.error('GitHub备用请求错误:', fallbackError.message);
              res.statusCode = 404;
              serveCustomErrorPage(config.customPages.notFoundPath, res, 404);
            });
          }
        });
        return;
      }
      
      // 修改：优先检查public目录下的文件
      const publicFilePath = path.join(process.cwd(), 'public', req.url.startsWith('/') ? req.url.substring(1) : req.url);
      const filePath = path.join(process.cwd(), req.url.startsWith('/') ? req.url.substring(1) : req.url);
      
      // 检查文件是否存在
      try {
        // 首先检查public目录
        if(fs.existsSync(publicFilePath)) {
          // 文件存在，提供文件服务
          const ext = path.extname(publicFilePath).toLowerCase();
          let contentType = 'text/plain';
          
          // 设置内容类型
          switch(ext) {
            case '.html': contentType = 'text/html'; break;
            case '.js': contentType = 'application/javascript'; break;
            case '.css': contentType = 'text/css'; break;
            case '.json': contentType = 'application/json'; break;
            case '.png': contentType = 'image/png'; break;
            case '.jpg': case '.jpeg': contentType = 'image/jpeg'; break;
            case '.gif': contentType = 'image/gif'; break;
            case '.svg': contentType = 'image/svg+xml'; break;
            case '.ico': contentType = 'image/x-icon'; break;
            case '.woff': case '.woff2': contentType = 'font/woff2'; break;
            case '.ttf': contentType = 'font/ttf'; break;
            case '.eot': contentType = 'application/vnd.ms-fontobject'; break;
          }
          
          // 设置缓存头
          res.setHeader('Cache-Control', 'public, max-age=86400'); // 24小时缓存
          res.setHeader('Expires', new Date(Date.now() + 86400000).toUTCString());
          
          // 提供文件
          res.setHeader('Content-Type', contentType);
          fs.createReadStream(publicFilePath).pipe(res);
          return;
        } else if(!fs.existsSync(filePath)) {
          // 如果是GitHub资源文件，直接转发请求
          if(req.url.startsWith('/assets/')) {
            const targetUrl = `https://github.githubassets.com${req.url.replace('/assets', '')}`;
            axios.get(targetUrl, {
              responseType: 'arraybuffer',
              timeout: 10000,
              maxRedirects: 5
            })
            .then(response => {
              if(res.headersSent) return;
              // 设置缓存头
              res.setHeader('Cache-Control', 'public, max-age=86400');
              res.setHeader('Expires', new Date(Date.now() + 86400000).toUTCString());
              res.statusCode = response.status;
              res.end(response.data);
            })
            .catch(error => {
              // 如果是404错误，尝试从备用源获取
              if(error.response?.status === 404) {
                const fallbackUrl = targetUrl.replace('github.githubassets.com', 'raw.githubusercontent.com');
                axios.get(fallbackUrl, {
                  responseType: 'arraybuffer',
                  timeout: 10000,
                  maxRedirects: 5
                })
                .then(response => {
                  if(res.headersSent) return;
                  res.setHeader('Cache-Control', 'public, max-age=86400');
                  res.setHeader('Expires', new Date(Date.now() + 86400000).toUTCString());
                  res.statusCode = response.status;
                  res.end(response.data);
                })
                .catch(fallbackError => {
                  console.error('备用源获取失败:', fallbackError.message);
                  serveCustomErrorPage(config.customPages.notFoundPath, res, 404);
                });
              } else {
                console.error('从GitHub获取资源失败:', error.message);
                serveCustomErrorPage(config.customPages.notFoundPath, res, 404);
              }
            });
          } else {
            serveCustomErrorPage(config.customPages.notFoundPath, res, 404);
          }
          return;
        }
      } catch(err) {
        console.error(`检查文件存在出错:`, err.message);
        // 继续正常处理流程
      }
    }
    
    // 处理请求
    try {
      // 记录访问日志
      const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
      console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} (${clientIp})`);
      
      // 检查黑名单
      if (blockBlacklistedContent(req, res, () => {})) {
        return; // 如果被拦截，就不继续处理
      }
      
      // 路由请求
      route(req, res);
    } catch (err) {
      console.error('处理请求时出错:', err);
      handleError(err, req, res);
    }
  } catch (fatal) {
    // 捕获可能出现的最外层错误
    console.error('致命错误:', fatal);
    try {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end('服务器内部错误，请稍后重试');
      }
    } catch (e) {
      console.error('发送错误响应失败:', e);
    }
  }
});

// 为服务器添加全局错误处理
server.on('error', (err) => {
  console.error('服务器错误:', err.message);
  // 如果是地址占用错误，尝试使用其他端口
  if (err.code === 'EADDRINUSE') {
    console.log(`端口 ${config.server.port} 已被占用，尝试端口 ${config.server.port + 1}`);
    setTimeout(() => {
      server.close();
      server.listen(config.server.port + 1, config.server.host);
    }, 1000);
  }
});

// 为服务器添加连接错误处理
server.on('clientError', (err, socket) => {
  console.error('客户端连接错误:', err.message);
  // ECONNRESET错误不需要响应，客户端已经断开
  if (err.code !== 'ECONNRESET' && socket.writable) {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  }
});

// 设置保持连接超时
server.keepAliveTimeout = 120 * 1000; // 2分钟
server.headersTimeout = 60 * 1000; // 1分钟

// 最大连接数
server.maxConnections = 1000;

// 启动服务器
server.listen(config.server.port, config.server.host, () => {
  console.log(`GitHub代理服务器运行在 http://${config.server.host}:${config.server.port}`);
  console.log('支持的路由:');
  console.log('- /                  => 自定义首页');
  console.log('- /api/*             => GitHub API');
  console.log('- /raw/*             => Raw 内容');
  console.log('- /assets/*          => GitHub 静态资源');
  console.log('- /releases/*        => Releases 文件');
  console.log('- /codeload/*        => 代码下载');
  console.log('- /{user}/{repo}/... => GitHub 仓库');
  console.log('- /admin/*           => 管理API (需要鉴权)');
  console.log('\n按 Ctrl+C 停止服务器');
  
  // 启动CPU监控
  admin.startCpuMonitoring();
}); 