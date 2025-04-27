# GitHub代理服务

一个高性能GitHub代理服务器，支持全面的仓库内容访问、黑名单管理和用户管理系统。

## 主要功能

### 代理功能
- 支持GitHub仓库内容、API、原始文件等多种内容代理
- 智能缓存机制，提高访问速度和减轻源站压力
- 支持URL重写，无缝替换原始GitHub链接
- 内容安全策略(CSP)头处理，确保代理内容可正常显示

### 管理系统
- 完整的管理控制台界面，支持登录认证
- 实时系统监控，包括CPU利用率、内存使用情况和请求统计
- 性能指标分析，包括慢请求识别和错误日志记录
- 日志管理，包括访问日志、错误日志和被阻止请求日志的查看和清理

### 黑名单管理
- 支持按仓库路径、关键词进行黑名单过滤
- 黑名单热更新，无需重启服务
- 黑名单导入/导出功能
- 被阻止内容的自定义响应页面

### 用户管理系统（新功能）
- 基于JWT的用户认证系统，支持用户名/密码登录
- 多用户支持，包括管理员和普通用户角色区分
- 用户管理功能：添加、删除用户和密码修改
- 基于角色的访问控制
- 登录尝试限制，防止暴力破解

## 项目结构

### 核心模块
- `server.js`: 服务器入口，处理HTTP请求和静态文件服务
- `proxy.js`: GitHub代理核心逻辑，处理各类GitHub资源的请求转发
- `blacklist.js`: 黑名单配置和过滤逻辑
- `cache.js`: 缓存管理，提高响应速度
- `admin.js`: 管理API处理和认证逻辑
- `adminApi.js`: 管理功能相关API实现
- `userManager.js`: 用户管理系统，处理用户认证和权限控制
- `errorHandler.js`: 错误处理和自定义错误页面

### 界面文件
- `public/index.html`: 首页
- `public/404.html`: 自定义404错误页面
- `public/admin/login.html`: 管理员登录页面
- `public/admin/dashboard.html`: 管理控制台界面

## 配置文件
- `config/config.js`: 主配置文件，包含服务器和代理设置
- `config/blacklist.js`: 黑名单配置

## 安装和使用

### 环境要求
- Node.js 14.x 或更高版本
- NPM 6.x 或更高版本

### 安装步骤
1. 克隆仓库
2. 执行 `npm install` 安装依赖
3. 配置 `config/config.js` 文件
4. 执行 `npm start` 启动服务

### 默认账户
- 用户名: admin
- 密码: admin123

## 使用方法
将正常的GitHub链接中的域名替换为本代理服务的域名即可访问，例如：
- `https://github.com/user/repo` → `http://your-proxy-domain/user/repo`
- `https://raw.githubusercontent.com/user/repo/branch/file` → `http://your-proxy-domain/raw/user/repo/branch/file`

## 管理控制台
访问 `http://your-proxy-domain/admin/login.html` 登录管理控制台

## 功能特性

- **全面代理** - 代理 GitHub 网站、API、Raw 内容、Releases 文件等
- **自定义首页** - 使用自定义的首页、404和403页面
- **缓存系统** - 内置高效的缓存系统，减轻服务器负担并提高访问速度
- **管理API** - 提供缓存和状态监控接口
- **URL重写** - 自动修改HTML内容中的链接，确保无缝浏览体验
- **黑名单系统** - 支持自动过滤特定仓库，遵守相关法律法规

## 快速开始

### 前置条件

- Node.js >= 14.0.0
- npm 或 yarn

### 安装

```bash
# 克隆仓库
git clone https://github.com/yourusername/github-proxy.git
cd github-proxy

# 安装依赖
npm install

# 启动服务器
npm start
```

服务器默认在 http://0.0.0.0:3000 上运行。

### 开发模式

```bash
npm run dev
```

## 配置说明

配置文件位于 `config/config.js`，可以根据需要修改以下配置：

| 配置项 | 说明 |
|-------|------|
| server.port | 服务器端口号 |
| server.host | 服务器监听地址 |
| cache.enabled | 是否启用缓存 |
| cache.maxAge | 普通内容缓存时间(毫秒) |
| cache.staticMaxAge | 静态资源缓存时间(毫秒) |
| customPages.* | 自定义页面路径 |

## 路由说明

服务支持以下路由：

- `/` - 自定义首页
- `/api/*` - GitHub API
- `/raw/*` - Raw 内容
- `/assets/*` - GitHub 静态资源
- `/releases/*` - Releases 文件
- `/codeload/*` - 代码下载
- `/{user}/{repo}/...` - GitHub 仓库
- `/admin/*` - 管理API(需要鉴权)

## 管理API

服务提供了管理API，用于监控和维护服务状态：

| 路径 | 方法 | 说明 |
|-----|-----|------|
| /admin/api/login | POST | 用户登录 |
| /admin/cache/stats | GET | 获取缓存统计 |
| /admin/cache/clear | POST | 清理所有缓存 |
| /admin/stats | GET | 获取请求统计 |
| /admin/stats/reset | POST | 重置统计数据 |
| /admin/system | GET | 获取系统信息 |
| /admin/config | GET | 获取当前配置 |
| /admin/users | GET | 获取用户列表 |
| /admin/users/add | POST | 添加用户 |
| /admin/users/delete | POST | 删除用户 |
| /admin/users/change-password | POST | 修改指定用户密码 |
| /admin/users/change-my-password | POST | 修改当前登录用户的密码 |

所有管理API请求(除登录API外)需要在请求头中携带Authorization: Bearer {token}作为JWT令牌认证，或者使用传统方式Authorization: Bearer {token}，默认令牌为'admin123'，可通过环境变量 ADMIN_TOKEN 修改。

### 用户管理

系统内置了用户管理功能：

1. 默认管理员账号: admin / admin123
2. 支持用户认证模式: 
   - 传统令牌认证(TOKEN)
   - JWT认证(用于网页管理系统)
3. 用户可以通过管理界面修改自己的密码
4. 管理员可以添加、删除用户及修改其他用户的密码

### 管理控制台

系统提供了完整的Web管理界面，可通过以下方式访问：

1. **登录页面**: http://your-domain.com/admin/login.html
2. **管理控制台**: http://your-domain.com/admin/dashboard.html (需要先登录)

管理控制台功能：
- 系统监控: 实时显示系统运行状态、内存使用、CPU负载等
- 请求统计: 查看请求总数、成功率等数据
- 缓存管理: 查看和清理缓存
- 黑名单管理: 管理黑名单规则
- 日志查看: 查看系统日志
- 用户管理: 添加/删除/修改用户

## 使用示例

**直接访问仓库**

```
http://your-domain.com/username/repo
```

**访问Raw内容**

```
http://your-domain.com/raw/username/repo/branch/path/to/file
```

**访问API**

```
http://your-domain.com/api/repos/username/repo
```

**下载Release文件**

```
http://your-domain.com/releases/username/repo/releases/download/v1.0/file.zip
```

## 环境变量

可以通过以下环境变量自定义配置：

- `PORT` - 服务器端口号
- `HOST` - 服务器监听地址
- `ADMIN_TOKEN` - 管理API鉴权令牌

## 部署

### 使用PM2

```bash
npm install pm2 -g
pm2 start src/server.js --name github-proxy
```

### 使用Docker

```bash
docker build -t github-proxy .
docker run -p 3000:3000 github-proxy
```

## 注意事项

- 本代理仅供学习和研究使用，请勿用于任何商业用途
- 使用本代理访问GitHub时，请遵守GitHub的服务条款
- 请勿过度爬取GitHub内容，以免触发GitHub的访问限制

## 内容审核与黑名单

服务包含内容黑名单系统，用于阻止访问违反中国大陆法律法规的仓库：

### 黑名单配置

黑名单配置文件位于 `config/blacklist.js`，可以根据需要修改以下配置：

| 配置项 | 说明 |
|-------|------|
| repositories | 完全匹配的仓库列表 (格式：owner/repo) |
| keywords | 仓库名关键词黑名单 (部分匹配) |
| whitelistRepositories | 例外白名单列表 |
| enabled | 启用或禁用黑名单功能 |
| logBlocked | 是否记录被拦截的访问 |
| errorResponse | 自定义错误响应设置 |

### 黑名单工作原理

- 系统会自动检查用户请求的仓库路径
- 如果匹配黑名单中的仓库或关键词，将返回HTTP 451错误（因法律原因不可用）
- 黑名单同时适用于主页、API和Raw内容请求

## 网络稳定性优化

为解决在Linux系统和某些网络环境下可能出现的连接问题，本项目实现了以下优化：

### ECONNRESET错误修复

最新版本修复了在Linux下常见的`socket hang up`和`ECONNRESET`错误:

- **自动重试机制**: 对临时网络错误如`ECONNRESET`、`ECONNABORTED`自动执行重试
- **超时优化**: 增加了更合理的连接超时和请求超时设置
- **Socket错误处理**: 增强了底层网络异常的捕获和处理机制

### 用户代理(UA)配置

完善的User-Agent配置可有效避免被目标服务器拒绝：

- **多样化UA**: 使用标准浏览器格式的User-Agent，避免被GitHub API限制
- **随机UA选择**: 从多个真实浏览器UA中随机选择，降低被识别为自动化工具的风险
- **完整请求头**: 添加Accept、Accept-Encoding等头信息，使请求更接近真实浏览器

这些优化使代理服务在各种网络环境和操作系统下都能稳定运行，特别是解决了Linux系统下的常见连接问题。

## 性能监控与日志功能

本系统集成了全面的性能监控和日志管理功能，用于帮助管理员实时了解系统状态并排查问题：

### 性能监控

- **系统资源监控**：实时监控CPU使用率、内存占用、请求统计等关键指标
- **热门仓库统计**：自动统计访问量最高的仓库，便于内容优化
- **慢请求分析**：记录响应时间超过1秒的请求，帮助定位性能瓶颈
- **错误请求追踪**：集中展示所有错误请求，方便快速响应和修复

性能数据会自动刷新，管理员可在控制面板上查看详细报告。

### 日志管理

系统提供三种日志类型的全面记录和管理功能：

- **访问日志**：记录所有访问请求，包含IP、时间、请求路径等信息
- **错误日志**：详细记录系统运行中的错误，包含完整的错误栈信息
- **拦截日志**：记录被黑名单规则拦截的所有访问尝试

日志功能包括：
- 根据类型查看指定数量的最新日志记录
- 清空特定类型的日志
- 查看日志文件统计信息（总行数、显示行数等）

所有日志文件存储在项目根目录的`logs`文件夹下，可通过管理界面或直接访问文件进行查看。

### 最近更新

- 修复了日志API路径不匹配问题，现在日志功能可以正常工作
- 优化了CPU监控功能，确保服务器启动时自动开始收集系统性能数据
- 修复了系统信息API数据结构与前端显示不一致的问题
- 增强了错误处理和数据展示的稳定性

所有这些功能都通过管理控制台提供直观的用户界面，访问路径为`/admin/dashboard.html`。

## License

MIT 