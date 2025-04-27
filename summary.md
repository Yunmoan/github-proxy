# performanceData 初始化和使用流程分析

## 初始化

在 `src/adminApi.js` 文件中，`performanceData` 对象被初始化为：

```javascript
// 性能指标收集
const performanceData = {
  startTime: Date.now(),
  requestsProcessed: 0,
  averageResponseTime: 0,
  totalResponseTime: 0,
  slowRequests: [], // 最慢的10个请求
  errors: 0,
  pathStats: {}, // 初始化 pathStats 对象
  repositoryStats: {} // 添加仓库统计对象
};
```

## 数据收集流程

1. **性能监控中间件**：
   在 `src/admin.js` 中，`performanceMiddleware` 函数会在每个管理API请求开始时记录时间，然后在请求结束时计算耗时并记录：

   ```javascript
   const performanceMiddleware = (req, res, next) => {
     const start = Date.now();
     
     // 响应完成后记录性能指标
     res.on('finish', () => {
       const duration = Date.now() - start;
       adminApi.recordPerformanceDataPoint(req.url, duration, res.statusCode, 0);
     });
     
     next();
   };
   ```

2. **记录性能数据点**：
   `recordPerformanceDataPoint` 函数在 `src/adminApi.js` 中定义，用于更新性能数据：
   - 递增请求处理计数
   - 计算平均响应时间
   - 记录慢请求（响应时间 > 1000ms）
   - 记录错误请求（状态码 >= 400）
   - 更新路径和仓库的统计信息

3. **提取仓库信息**：
   从请求路径中提取仓库信息，格式为 "/用户名/仓库名"，并维护每个仓库的访问统计。

## 数据获取与展示

1. **API端点**：
   在 `src/admin.js` 中，`/admin/performance` 路由处理程序返回性能指标数据：
   ```javascript
   else if (path === '/admin/performance') {
     // 获取性能指标
     responseData = adminApi.getPerformanceMetrics();
   }
   ```

2. **获取性能指标**：
   `getPerformanceMetrics` 函数返回格式化的性能数据，包括：
   - 系统运行时间
   - 内存使用情况
   - CPU使用率
   - 请求处理统计
   - 仓库访问排名（按请求量排序）

3. **前端展示**：
   在 `public/admin/dashboard.html` 中：
   - `loadPerformanceData` 函数从 `/admin/performance` 获取数据并展示
   - `loadTopRepos` 函数专门展示热门仓库访问统计

## 数据持久化

在程序退出时，通过 `process.on('exit', ...)` 钩子将性能数据保存到日志文件：
```javascript
process.on('exit', () => {
  try {
    // 保存性能数据
    const perfLogPath = path.join(logDir, 'performance.log');
    fs.appendFileSync(perfLogPath, `${new Date().toISOString()} | 服务结束 | 处理请求: ${performanceData.requestsProcessed} | 平均响应时间: ${performanceData.averageResponseTime.toFixed(2)}ms\n`);
  } catch (err) {
    console.error('保存性能日志失败:', err.message);
  }
});
```

## 自动刷新机制

仪表盘页面实现了性能数据的自动刷新：
- 通过设置间隔时间定期调用API获取最新数据
- 可以通过UI控制启用/禁用自动刷新
- 不同类型的数据有不同的刷新频率 