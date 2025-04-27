module.exports = {
  server: {
    port: process.env.PORT || 3000,
    host: process.env.HOST || '0.0.0.0'
  },
  github: {
    baseUrl: 'https://github.com',
    apiUrl: 'https://api.github.com',
    rawUrl: 'https://raw.githubusercontent.com',
    assetsUrl: 'https://github.githubassets.com',
    releaseUrl: 'https://github-releases.githubusercontent.com',
    codeloadUrl: 'https://codeload.github.com'
  },
  cache: {
    enabled: true,
    maxAge: 60 * 60 * 1000, // 1小时
    staticMaxAge: 24 * 60 * 60 * 1000 // 24小时
  },
  customPages: {
    homePath: './public/home.html',
    notFoundPath: './public/404.html',
    forbiddenPath: './public/403.html',
    unavailablePath: './public/451.html' // 法律原因不可用页面
  }
} 