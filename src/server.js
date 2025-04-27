const http = require('http');
const fs = require('fs');
const path = require('path');
const config = require('../config/config');
const { route } = require('./proxy');
const { handleError, serveCustomErrorPage } = require('./errorHandler');
const { blockBlacklistedContent } = require('./blacklist');
const admin = require('./admin'); // 导入admin模块

// 请求超时设置
const REQUEST_TIMEOUT = 2 * 60 * 1000; // 2分钟

// 创建HTTP服务器
const server = http.createServer((req, res) => {
  // 设置请求超时
  req.setTimeout(REQUEST_TIMEOUT);
  res.setTimeout(REQUEST_TIMEOUT);
  
  // 添加基本的错误处理
  req.on('error', (err) => {
    console.error('请求错误:', err.message);
    handleError(err, req, res);
  });
  
  res.on('error', (err) => {
    console.error('响应错误:', err.message);
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
  
  // 如果是静态文件请求且文件不存在，直接返回404
  if(req.url.match(/\.(html|js|css|jpg|jpeg|png|gif|ico|svg|woff|woff2|ttf|eot)$/i)) {
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
        }
        
        // 提供文件
        res.setHeader('Content-Type', contentType);
        fs.createReadStream(publicFilePath).pipe(res);
        return;
      } else if(!fs.existsSync(filePath)) {
        console.log(`静态文件不存在，返回404: ${req.url}`);
        serveCustomErrorPage(config.customPages.notFoundPath, res, 404);
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

// 设置保持连接超时
server.keepAliveTimeout = 120 * 1000; // 2分钟
server.headersTimeout = 60 * 1000; // 1分钟

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