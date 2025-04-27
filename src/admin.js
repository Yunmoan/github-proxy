const express = require('express');
// 将node-fetch从require方式改为动态导入
let fetch;
import('node-fetch').then(module => {
  fetch = module.default;
});
const { createProxyMiddleware } = require('http-proxy-middleware');
const Cache = require('./cache');
const config = require('../config/config');
const blacklist = require('./blacklist');
const adminApi = require('./adminApi');
const os = require('os');
const { safeStringify } = require('./errorHandler');
const { getCurrentConfig, getBlacklistStats, forceReloadConfig } = require('./blacklist');
const jwt = require('jsonwebtoken');
const userManager = require('./userManager');

// JWT密钥，在生产环境请使用更安全的方式存储
const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-jwt-key-please-change-in-production';
const JWT_EXPIRE = '24h'; // Token有效期24小时

// 简单的鉴权 - 在实际生产中应使用更强的鉴权机制
const AUTH_TOKEN = process.env.ADMIN_TOKEN || 'admin123'; // 默认令牌，建议在生产中修改

// 允许的IP地址白名单
const ALLOWED_IPS = process.env.ADMIN_ALLOWED_IPS ? process.env.ADMIN_ALLOWED_IPS.split(',') : ['127.0.0.1', '::1'];

// 请求统计
const stats = {
  startTime: Date.now(),
  requestsTotal: 0,
  requestsSuccess: 0,
  requestsError: 0,
  byPath: {},
  recentRequests: [] // 最近100个请求的简要信息
};

// 最大记录的近期请求数量
const MAX_RECENT_REQUESTS = 100;

// CPU使用率历史数据
const cpuHistory = [];
const MAX_HISTORY_LENGTH = 60; // 保存最近60个采样点
let lastCpuUsage = null;

// 获取CPU使用率
const getCpuUsage = () => {
  const cpus = os.cpus();
  
  if (!cpus || !cpus.length) {
    return { usage: 0, perCore: [] };
  }
  
  const currentCpuUsage = cpus.map(cpu => {
    const total = Object.values(cpu.times).reduce((acc, tv) => acc + tv, 0);
    return { total, idle: cpu.times.idle };
  });
  
  // 首次调用无法计算差值
  if (!lastCpuUsage) {
    lastCpuUsage = currentCpuUsage;
    return { usage: 0, perCore: cpus.map(() => 0) };
  }
  
  // 计算每个核心的使用率
  const perCore = currentCpuUsage.map((curr, i) => {
    const prev = lastCpuUsage[i];
    const totalDiff = curr.total - prev.total;
    const idleDiff = curr.idle - prev.idle;
    return totalDiff > 0 ? Math.round((1 - idleDiff / totalDiff) * 100) : 0;
  });
  
  // 计算总体使用率
  const usage = Math.round(perCore.reduce((acc, val) => acc + val, 0) / perCore.length);
  
  // 更新
  lastCpuUsage = currentCpuUsage;
  
  // 记录历史
  const timestamp = Date.now();
  cpuHistory.push({ usage, timestamp });
  if (cpuHistory.length > MAX_HISTORY_LENGTH) {
    cpuHistory.shift();
  }
  
  return { usage, perCore };
};

// 获取详细的系统资源使用信息
const getDetailedSystemInfo = () => {
  const memInfo = {
    total: os.totalmem(),
    free: os.freemem(),
    used: os.totalmem() - os.freemem(),
    percentUsed: ((1 - os.freemem() / os.totalmem()) * 100).toFixed(2)
  };
  
  const cpuInfo = getCpuUsage();
  
  const loadAvg = os.loadavg();
  
  const networkInterfaces = Object.entries(os.networkInterfaces()).reduce((acc, [name, interfaces]) => {
    acc[name] = interfaces.filter(iface => !iface.internal);
    return acc;
  }, {});
  
  return {
    timestamp: Date.now(),
    uptime: {
      system: os.uptime(),
      formatted: formatUptime(os.uptime()),
      process: process.uptime(),
      processFormatted: formatUptime(process.uptime())
    },
    cpu: {
      model: os.cpus()[0]?.model || 'Unknown',
      cores: os.cpus().length,
      usage: cpuInfo.usage,
      perCore: cpuInfo.perCore,
      history: cpuHistory,
      loadAverage: {
        '1m': loadAvg[0].toFixed(2),
        '5m': loadAvg[1].toFixed(2),
        '15m': loadAvg[2].toFixed(2)
      }
    },
    memory: {
      total: memInfo.total,
      totalFormatted: formatBytes(memInfo.total),
      free: memInfo.free,
      freeFormatted: formatBytes(memInfo.free),
      used: memInfo.used,
      usedFormatted: formatBytes(memInfo.used),
      percentUsed: memInfo.percentUsed + '%',
      process: {
        rss: process.memoryUsage().rss,
        rssFormatted: formatBytes(process.memoryUsage().rss),
        heapTotal: process.memoryUsage().heapTotal,
        heapTotalFormatted: formatBytes(process.memoryUsage().heapTotal),
        heapUsed: process.memoryUsage().heapUsed,
        heapUsedFormatted: formatBytes(process.memoryUsage().heapUsed),
        external: process.memoryUsage().external,
        externalFormatted: formatBytes(process.memoryUsage().external)
      }
    },
    network: networkInterfaces,
    platform: {
      os: process.platform,
      version: os.release(),
      arch: process.arch,
      nodeVersion: process.version
    },
    diskSpace: null // 在Node.js中获取磁盘空间需要额外依赖，暂不实现
  };
};

const recordRequest = (path, success, statusCode = 200, responseTime = 0) => {
  stats.requestsTotal++;
  success ? stats.requestsSuccess++ : stats.requestsError++;
  
  // 统计热点路径
  const basePath = path.split('/').slice(0, 3).join('/');
  stats.byPath[basePath] = (stats.byPath[basePath] || 0) + 1;
  
  // 记录最近请求
  const timestamp = Date.now();
  stats.recentRequests.unshift({
    path,
    timestamp,
    statusCode,
    responseTime,
    success
  });
  
  // 限制最近请求数量
  if (stats.recentRequests.length > MAX_RECENT_REQUESTS) {
    stats.recentRequests.pop();
  }
};

// 清空统计数据
const resetStats = () => {
  stats.requestsTotal = 0;
  stats.requestsSuccess = 0;
  stats.requestsError = 0;
  stats.byPath = {};
  stats.recentRequests = [];
  return { message: '统计数据已重置' };
};

// 获取系统信息
const getSystemInfo = () => {
  const uptime = process.uptime();
  const memUsage = process.memoryUsage();
  
  return {
    platform: process.platform,
    nodeVersion: process.version,
    cpus: os.cpus().length,
    uptime: {
      seconds: uptime,
      formatted: formatUptime(uptime)
    },
    memory: {
      rss: formatBytes(memUsage.rss),
      heapTotal: formatBytes(memUsage.heapTotal),
      heapUsed: formatBytes(memUsage.heapUsed),
      external: formatBytes(memUsage.external)
    },
    systemMemory: {
      total: formatBytes(os.totalmem()),
      free: formatBytes(os.freemem()),
      usedPercentage: ((1 - os.freemem() / os.totalmem()) * 100).toFixed(2) + '%'
    }
  };
};

// 获取服务器配置
const getConfig = () => {
  // 移除敏感信息
  const safeConfig = JSON.parse(JSON.stringify(config));
  delete safeConfig.auth;
  return safeConfig;
};

// 时间格式化
const formatUptime = (seconds) => {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  
  return `${days}天 ${hours}小时 ${minutes}分钟 ${secs}秒`;
};

// 字节格式化
const formatBytes = (bytes) => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

// 验证IP访问权限
const isIPAllowed = (req) => {
  const clientIP = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
  return ALLOWED_IPS.includes('*') || ALLOWED_IPS.some(ip => clientIP.includes(ip));
};

// 检查鉴权 (支持Token和JWT两种认证方式)
const checkAuth = (req) => {
  // 先检查IP
  if (!isIPAllowed(req)) {
    return {
      authorized: false,
      statusCode: 403,
      message: '此IP地址不允许访问管理API'
    };
  }
  
  // 检查Authorization头，支持Bearer token (JWT) 和基础token
  const authHeader = req.headers['authorization'];
  
  if (!authHeader) {
    return {
      authorized: false,
      statusCode: 401,
      message: '未提供认证信息'
    };
  }
  
  // 检查Bearer token (JWT)
  if (authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    try {
      // 验证JWT
      const decoded = jwt.verify(token, JWT_SECRET);
      // 验证通过
      return { authorized: true, user: decoded };
    } catch (error) {
      // JWT验证失败，尝试使用传统token
      if (token === AUTH_TOKEN) {
        return { authorized: true };
      }
      
      return {
        authorized: false,
        statusCode: 401,
        message: '无效的JWT令牌'
      };
    }
  }
  
  // 检查传统令牌
  const token = authHeader.split(' ')[1];
  if (token === AUTH_TOKEN) {
    return { authorized: true };
  }
  
  return {
    authorized: false,
    statusCode: 401,
    message: '未授权访问'
  };
};

// 从请求体中解析JSON数据
const parseJsonBody = (req) => {
  return new Promise((resolve, reject) => {
    try {
      let body = '';
      req.on('data', chunk => {
        body += chunk.toString();
      });
      
      req.on('end', () => {
        try {
          const data = body ? JSON.parse(body) : {};
          resolve(data);
        } catch (e) {
          reject(new Error('无效的JSON格式'));
        }
      });
      
      req.on('error', err => {
        reject(err);
      });
    } catch (err) {
      reject(err);
    }
  });
};

// 解析URL查询参数
const parseQueryParams = (url) => {
  const params = {};
  const parsedUrl = new URL(url, `http://${url.host || 'localhost'}`);
  for (const [key, value] of parsedUrl.searchParams.entries()) {
    params[key] = value;
  }
  return params;
};

// 处理管理API请求
const handleAdminRequest = async (req, res) => {
  const startTime = Date.now();
  let responseStatusCode = 200;
  
  try {
    // 记录访问
    adminApi.logAccess(req);
    
    // 特殊路径：登录API不需要验证
    if (req.url === '/admin/api/login' && req.method === 'POST') {
      await handleLoginRequest(req, res);
      return;
    }
    
    // 验证鉴权
    const authResult = checkAuth(req);
    if (!authResult.authorized) {
      res.statusCode = authResult.statusCode;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(safeStringify({ error: authResult.message }));
      responseStatusCode = authResult.statusCode;
      return;
    }
    
    // 设置响应头
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    
    // 根据路径分发请求
    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = url.pathname;
    const queryParams = parseQueryParams(url);
    
    let responseData = null;
    
    // API路由处理
    if (path === '/admin/cache/stats') {
      // 获取缓存统计
      responseData = Cache.getStats();
    } else if (path === '/admin/cache/clear' && req.method === 'POST') {
      // 清除缓存
      responseData = Cache.clear();
    } else if (path === '/admin/stats') {
      // 获取请求统计
      responseData = {
        ...stats,
        uptime: formatUptime(process.uptime()),
        startTime: new Date(stats.startTime).toISOString()
      };
    } else if (path === '/admin/stats/reset' && req.method === 'POST') {
      // 重置统计
      responseData = resetStats();
    } else if (path === '/admin/system') {
      // 获取系统信息
      responseData = getSystemInfo();
    } else if (path === '/admin/system/detailed') {
      // 获取详细的系统资源使用信息
      responseData = getDetailedSystemInfo();
    } else if (path === '/admin/performance') {
      // 获取性能指标
      responseData = await adminApi.getPerformanceMetrics();
    } else if (path === '/admin/performance/reset' && req.method === 'POST') {
      // 重置性能数据
      responseData = adminApi.resetPerformanceData();
    } else if (path === '/admin/performance/add-samples' && req.method === 'POST') {
      // 返回不支持信息
      responseData = {
        success: false,
        message: '不再支持添加示例数据功能',
        timestamp: new Date().toISOString()
      };
    } else if (path === '/admin/config') {
      // 获取配置信息
      responseData = getConfig();
    } else if (path === '/admin/blacklist') {
      // 获取黑名单配置
      responseData = getCurrentConfig();
    } else if (path === '/admin/blacklist/stats') {
      // 获取黑名单统计
      responseData = getBlacklistStats();
    } else if (path === '/admin/blacklist/reload' && req.method === 'POST') {
      // 手动重新加载黑名单
      const success = forceReloadConfig();
      responseData = {
        success,
        message: success ? '黑名单配置已重新加载' : '重新加载黑名单配置失败',
        timestamp: new Date().toISOString()
      };
    } else if (path === '/admin/blacklist/update' && req.method === 'POST') {
      // 更新黑名单配置
      const data = await parseJsonBody(req);
      responseData = await adminApi.updateBlacklist(data);
    } else if (path === '/admin/blacklist/add' && req.method === 'POST') {
      // 添加黑名单条目
      const data = await parseJsonBody(req);
      responseData = await adminApi.addBlacklistEntry(data);
    } else if (path === '/admin/blacklist/remove' && req.method === 'POST') {
      // 删除黑名单条目
      const data = await parseJsonBody(req);
      responseData = await adminApi.removeBlacklistEntry(data);
    } else if (path === '/admin/blacklist/export') {
      // 导出黑名单配置
      responseData = await adminApi.exportBlacklist();
    } else if (path === '/admin/blacklist/import' && req.method === 'POST') {
      // 导入黑名单配置
      const data = await parseJsonBody(req);
      responseData = await adminApi.importBlacklist(data);
    } else if (path === '/admin/logs') {
      // 获取日志文件列表
      responseData = adminApi.getLogFiles();
    } else if (path.startsWith('/admin/logs/') && path.split('/').length === 4) {
      // 读取特定日志文件 - 例如 /admin/logs/access?limit=100
      const logType = path.split('/')[3].split('?')[0]; // 去除查询参数
      const limit = queryParams.limit ? parseInt(queryParams.limit) : 100;
      responseData = await adminApi.readLogFile(logType, limit);
    } else if (path.match(/^\/admin\/logs\/\w+\/clear$/) && req.method === 'POST') {
      // 清除特定日志文件 - 例如 /admin/logs/access/clear
      const logType = path.split('/')[3];
      responseData = await adminApi.clearLogFile(logType);
    } else if (path === '/admin/users' && req.method === 'GET') {
      // 获取用户列表
      responseData = userManager.getUsers();
    } else if (path === '/admin/users/add' && req.method === 'POST') {
      // 添加用户
      const data = await parseJsonBody(req);
      // 确保data包含必要的用户信息
      if (!data.username || !data.password) {
        responseData = { success: false, message: '用户名和密码不能为空' };
        responseStatusCode = 400;
      } else {
        responseData = userManager.addUser(data);
      }
    } else if (path === '/admin/users/delete' && req.method === 'POST') {
      // 删除用户
      const data = await parseJsonBody(req);
      responseData = userManager.deleteUser(data.username);
    } else if (path === '/admin/users/change-password' && req.method === 'POST') {
      // 修改密码
      const data = await parseJsonBody(req);
      responseData = userManager.changePassword(data.username, data.newPassword);
    } else if (path === '/admin/users/change-my-password' && req.method === 'POST') {
      // 修改自己的密码
      const data = await parseJsonBody(req);
      // 确保用户已登录并且只能修改自己的密码
      if (authResult.user && authResult.user.username) {
        if (data.oldPassword && data.newPassword) {
          // 先验证旧密码
          const isValid = userManager.verifyUser(authResult.user.username, data.oldPassword);
          if (isValid) {
            responseData = userManager.changePassword(authResult.user.username, data.newPassword);
          } else {
            responseData = { error: '旧密码不正确' };
            responseStatusCode = 401;
          }
        } else {
          responseData = { error: '必须提供旧密码和新密码' };
          responseStatusCode = 400;
        }
      } else {
        responseData = { error: '无法确认用户身份' };
        responseStatusCode = 403;
      }
    } else if (path === '/admin' || path === '/admin/') {
      // 管理API信息
      responseData = {
        service: 'GitHub代理服务管理API',
        version: '1.0',
        endpoints: [
          { path: '/admin/api/login', methods: ['POST'], description: '用户登录' },
          { path: '/admin/stats', methods: ['GET'], description: '获取请求统计' },
          { path: '/admin/stats/reset', methods: ['POST'], description: '重置请求统计' },
          { path: '/admin/system', methods: ['GET'], description: '获取系统信息' },
          { path: '/admin/system/detailed', methods: ['GET'], description: '获取详细的系统资源使用信息' },
          { path: '/admin/performance', methods: ['GET'], description: '获取性能指标' },
          { path: '/admin/performance/reset', methods: ['POST'], description: '重置性能数据' },
          { path: '/admin/performance/add-samples', methods: ['POST'], description: '添加示例数据' },
          { path: '/admin/config', methods: ['GET'], description: '获取配置信息' },
          { path: '/admin/cache/stats', methods: ['GET'], description: '获取缓存统计' },
          { path: '/admin/cache/clear', methods: ['POST'], description: '清除缓存' },
          { path: '/admin/blacklist', methods: ['GET'], description: '获取黑名单配置' },
          { path: '/admin/blacklist/stats', methods: ['GET'], description: '获取黑名单统计' },
          { path: '/admin/blacklist/reload', methods: ['POST'], description: '重新加载黑名单配置' },
          { path: '/admin/blacklist/update', methods: ['POST'], description: '更新黑名单配置' },
          { path: '/admin/blacklist/add', methods: ['POST'], description: '添加黑名单条目' },
          { path: '/admin/blacklist/remove', methods: ['POST'], description: '删除黑名单条目' },
          { path: '/admin/blacklist/export', methods: ['GET'], description: '导出黑名单配置' },
          { path: '/admin/blacklist/import', methods: ['POST'], description: '导入黑名单配置' },
          { path: '/admin/logs', methods: ['GET'], description: '获取日志文件列表' },
          { path: '/admin/logs/read', methods: ['GET'], description: '读取日志文件内容' },
          { path: '/admin/logs/clear', methods: ['POST'], description: '清空日志文件' },
          { path: '/admin/users', methods: ['GET'], description: '获取用户列表' },
          { path: '/admin/users/add', methods: ['POST'], description: '添加用户' },
          { path: '/admin/users/delete', methods: ['POST'], description: '删除用户' },
          { path: '/admin/users/change-password', methods: ['POST'], description: '修改用户密码' },
          { path: '/admin/users/change-my-password', methods: ['POST'], description: '修改当前登录用户的密码' }
        ]
      };
    } else {
      // 未知路径
      responseData = {
        error: '未知的API路径',
        path: path
      };
      responseStatusCode = 404;
    }
    
    res.statusCode = responseStatusCode;
    res.end(safeStringify(responseData));
    recordRequest(req.url, true, responseStatusCode, Date.now() - startTime);
    // 同时记录性能数据
    adminApi.recordPerformanceDataPoint(req.url, Date.now() - startTime, responseStatusCode, Buffer.byteLength(safeStringify(responseData)));
    
  } catch (error) {
    console.error('管理API错误:', error);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    const errorResponse = safeStringify({
      error: '服务器错误',
      message: error.message
    });
    res.end(errorResponse);
    
    // 记录错误
    adminApi.logError(req, error);
    recordRequest(req.url, false, 500, Date.now() - startTime);
    // 记录性能数据(错误)
    adminApi.recordPerformanceDataPoint(req.url, Date.now() - startTime, 500, Buffer.byteLength(errorResponse));
  }
};

// 处理用户登录请求
const handleLoginRequest = async (req, res) => {
  try {
    // 解析请求体
    const data = await parseJsonBody(req);
    const { username, password } = data;
    
    // 验证用户名和密码
    if (!username || !password) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(safeStringify({ error: '用户名和密码不能为空' }));
      return;
    }
    
    // 验证用户
    const isValid = userManager.verifyUser(username, password);
    
    if (isValid) {
      // 生成JWT令牌
      const token = jwt.sign(
        { username, role: 'admin' }, // payload，可以加入更多用户信息
        JWT_SECRET,
        { expiresIn: JWT_EXPIRE }
      );
      
      // 返回成功响应
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(safeStringify({ 
        success: true,
        token,
        username,
        message: '登录成功' 
      }));
      
      // 记录成功登录
      adminApi.logAccess(req, `用户 ${username} 登录成功`);
    } else {
      // 返回错误响应
      res.statusCode = 401;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(safeStringify({ 
        error: '认证失败',
        message: '用户名或密码不正确' 
      }));
      
      // 记录失败登录
      adminApi.logError(req, new Error(`用户 ${username} 登录失败`));
    }
  } catch (error) {
    // 错误处理
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(safeStringify({
      error: '服务器错误',
      message: error.message
    }));
    
    // 记录错误
    adminApi.logError(req, error);
  }
};

// 用于验证管理员认证
const verifyAdmin = (req, res, next) => {
  const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
  const ADMIN_ALLOWED_IPS = (process.env.ADMIN_ALLOWED_IPS || '127.0.0.1,::1').split(',');
  
  // 记录访问日志
  adminApi.logAccess(req);
  
  // 获取客户端IP
  const clientIP = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  
  // 检查IP白名单
  if (!ADMIN_ALLOWED_IPS.some(ip => clientIP === ip || clientIP.startsWith(ip))) {
    adminApi.logError(req, new Error('IP地址未授权'));
    return res.status(403).json({ error: '未授权的IP地址' });
  }
  
  // 如果设置了管理员令牌，则验证请求头中的令牌
  if (ADMIN_TOKEN) {
    const token = req.headers['x-admin-token'];
    if (token !== ADMIN_TOKEN) {
      adminApi.logError(req, new Error('无效的管理员令牌'));
      return res.status(401).json({ error: '无效的管理员令牌' });
    }
  }
  
  next();
};

// 用于性能监控的中间件
const performanceMiddleware = (req, res, next) => {
  const start = Date.now();
  
  // 响应完成后记录性能指标
  res.on('finish', () => {
    const duration = Date.now() - start;
    adminApi.recordPerformanceDataPoint(req.url, duration, res.statusCode, 0);
  });
  
  next();
};

// 创建管理路由器
const createAdminRouter = () => {
  const router = express.Router();
  
  // 应用验证中间件和性能监控中间件
  router.use(verifyAdmin);
  router.use(performanceMiddleware);

  // 缓存管理
  router.get('/cache/stats', (req, res) => {
    const stats = Cache.getStats();
    res.json({
      cacheSize: stats.size,
      cacheItemCount: stats.itemCount,
      cacheHitCount,
      cacheMissCount,
      cacheHitRate: (cacheHitCount + cacheMissCount) > 0 
        ? (cacheHitCount / (cacheHitCount + cacheMissCount) * 100).toFixed(2) + '%' 
        : '0%'
    });
  });
  
  router.post('/cache/clear', (req, res) => {
    Cache.clear();
    res.json({ success: true, message: '缓存已清除' });
  });

  // 请求统计
  router.get('/stats', (req, res) => {
    const pathStats = Object.entries(stats.byPath).map(([path, count]) => ({
      path,
      count
    })).sort((a, b) => b.count - a.count);
    
    res.json({
      totalRequests: stats.requestsTotal,
      pathStats
    });
  });
  
  router.post('/stats/reset', (req, res) => {
    resetStats();
    res.json({ success: true, message: '统计已重置' });
  });

  // 系统信息
  router.get('/system', (req, res) => {
    const systemInfo = {
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      cpus: os.cpus().length,
      uptime: Math.floor(os.uptime()),
      memory: {
        total: os.totalmem(),
        free: os.freemem(),
        usage: ((1 - os.freemem() / os.totalmem()) * 100).toFixed(2) + '%'
      },
      versions: process.versions,
      env: {
        NODE_ENV: process.env.NODE_ENV || 'development'
      }
    };
    
    res.json(systemInfo);
  });
  
  // 详细系统资源使用情况
  router.get('/system/detailed', (req, res) => {
    try {
      const metrics = adminApi.getPerformanceMetrics();
      res.json(metrics);
    } catch (err) {
      adminApi.logError(req, err);
      res.status(500).json({ error: '获取系统资源信息失败', message: err.message });
    }
  });

  // 配置信息
  router.get('/config', (req, res) => {
    // 移除敏感信息
    const safeConfig = { ...config };
    delete safeConfig.githubToken;
    
    res.json(safeConfig);
  });

  // 黑名单管理
  router.get('/blacklist', (req, res) => {
    const blacklistConfig = getCurrentConfig();
    res.json(blacklistConfig);
  });
  
  router.get('/blacklist/stats', (req, res) => {
    const stats = getBlacklistStats();
    res.json(stats);
  });
  
  router.post('/blacklist/reload', (req, res) => {
    forceReloadConfig();
    res.json({ success: true, message: '黑名单已重新加载' });
  });
  
  // 更新整个黑名单配置
  router.post('/blacklist/update', express.json(), (req, res) => {
    try {
      const result = adminApi.updateBlacklist(req.body);
      if (result.error) {
        return res.status(400).json(result);
      }
      res.json(result);
    } catch (err) {
      adminApi.logError(req, err);
      res.status(500).json({ error: '更新黑名单失败', message: err.message });
    }
  });
  
  // 添加黑名单条目
  router.post('/blacklist/add', express.json(), (req, res) => {
    try {
      const { type, value } = req.body;
      if (!type || !value) {
        return res.status(400).json({ error: '缺少必要的参数: type和value' });
      }
      
      const result = adminApi.addBlacklistEntry(req.body);
      if (result.error) {
        return res.status(400).json(result);
      }
      res.json(result);
    } catch (err) {
      adminApi.logError(req, err);
      res.status(500).json({ error: '添加黑名单条目失败', message: err.message });
    }
  });
  
  // 删除黑名单条目
  router.post('/blacklist/remove', express.json(), (req, res) => {
    try {
      const { type, value } = req.body;
      if (!type || !value) {
        return res.status(400).json({ error: '缺少必要的参数: type和value' });
      }
      
      const result = adminApi.removeBlacklistEntry(req.body);
      if (result.error) {
        return res.status(400).json(result);
      }
      res.json(result);
    } catch (err) {
      adminApi.logError(req, err);
      res.status(500).json({ error: '删除黑名单条目失败', message: err.message });
    }
  });
  
  // 导出黑名单配置
  router.get('/blacklist/export', (req, res) => {
    try {
      const result = adminApi.exportBlacklist();
      if (result.error) {
        return res.status(500).json(result);
      }
      
      // 设置下载头
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', 'attachment; filename=blacklist-config.json');
      
      res.json(result.data);
    } catch (err) {
      adminApi.logError(req, err);
      res.status(500).json({ error: '导出黑名单配置失败', message: err.message });
    }
  });
  
  // 导入黑名单配置
  router.post('/blacklist/import', express.json(), (req, res) => {
    try {
      const result = adminApi.importBlacklist(req.body);
      if (result.error) {
        return res.status(400).json(result);
      }
      res.json(result);
    } catch (err) {
      adminApi.logError(req, err);
      res.status(500).json({ error: '导入黑名单配置失败', message: err.message });
    }
  });
  
  // 日志管理
  router.get('/logs', (req, res) => {
    try {
      const result = adminApi.getLogFiles();
      if (result.error) {
        return res.status(500).json(result);
      }
      res.json(result);
    } catch (err) {
      adminApi.logError(req, err);
      res.status(500).json({ error: '获取日志文件列表失败', message: err.message });
    }
  });
  
  // 读取特定日志
  router.get('/logs/:logName', (req, res) => {
    try {
      const { logName } = req.params;
      const limit = parseInt(req.query.limit) || 100;
      
      const result = adminApi.readLogFile(logName, limit);
      if (result.error) {
        return res.status(404).json(result);
      }
      res.json(result);
    } catch (err) {
      adminApi.logError(req, err);
      res.status(500).json({ error: '读取日志失败', message: err.message });
    }
  });
  
  // 清空特定日志
  router.post('/logs/:logName/clear', (req, res) => {
    try {
      const { logName } = req.params;
      
      const result = adminApi.clearLogFile(logName);
      if (result.error) {
        return res.status(404).json(result);
      }
      res.json(result);
    } catch (err) {
      adminApi.logError(req, err);
      res.status(500).json({ error: '清空日志失败', message: err.message });
    }
  });

  return router;
};

// 计算CPU使用率并更新历史
const updateCpuHistory = () => {
  try {
    const cpus = os.cpus();
    let idle = 0;
    let total = 0;
    
    for (const cpu of cpus) {
      for (const type in cpu.times) {
        total += cpu.times[type];
      }
      idle += cpu.times.idle;
    }
    
    // 如果有上一个数据点，计算使用率
    if (cpuHistory.length > 0) {
      const lastMeasure = cpuHistory[cpuHistory.length - 1];
      const idleDiff = idle - lastMeasure.idle;
      const totalDiff = total - lastMeasure.total;
      
      const usage = totalDiff > 0 ? 100 - (100 * idleDiff / totalDiff) : 0;
      
      cpuHistory.push({
        timestamp: Date.now(),
        idle,
        total,
        usage
      });
      
      // 保持历史记录在限定长度内
      if (cpuHistory.length > MAX_HISTORY_LENGTH) {
        cpuHistory.shift();
      }
    } else {
      // 第一个数据点
      cpuHistory.push({
        timestamp: Date.now(),
        idle,
        total,
        usage: 0
      });
    }
  } catch (err) {
    console.error('更新CPU历史失败:', err.message);
  }
};

// 启动CPU使用率监控
const startCpuMonitoring = () => {
  setInterval(updateCpuHistory, 1000); // 每秒更新一次
};

// 获取CPU使用率历史
const getCpuHistory = () => {
  return cpuHistory;
};

// 记录请求到路由统计，此函数替代重复的recordRouteRequest
const recordPathRequest = (path) => {
  stats.requestsTotal++;
  stats.byPath[path] = (stats.byPath[path] || 0) + 1;
  
  // 尝试从路径中提取仓库信息并记录性能数据
  const repoMatch = path.match(/\/([^\/]+\/[^\/]+)(\/|$)/);
  if (repoMatch && repoMatch[1]) {
    const repoPath = repoMatch[1];
    // 排除非仓库路径
    if (!repoPath.includes('.') && !repoPath.includes('admin') && repoPath.includes('/')) {
      // 记录性能数据点，用0作为响应时间和状态码占位符
      adminApi.recordPerformanceDataPoint(path, 0, 200, 0);
    }
  }
};

// 记录缓存命中
const recordCacheHit = () => {
  stats.requestsSuccess++;
};

// 记录缓存未命中
const recordCacheMiss = () => {
  stats.requestsError++;
};

module.exports = {
  handleAdminRequest,
  createAdminRouter,
  recordRequest,
  recordCacheHit,
  recordCacheMiss,
  recordPathRequest, // 导出新函数替代recordRouteRequest
  startCpuMonitoring,
  getCpuHistory,
  getDetailedSystemInfo
}; 