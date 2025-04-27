const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const CONFIG = require('../config/config');

// 用户数据文件路径
const USER_FILE = path.join(__dirname, '../data/users.json');

// 确保存储目录存在
const ensureDirectoryExists = () => {
  const dir = path.dirname(USER_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
};

// 用户角色
const ROLES = {
  ADMIN: 'admin',
  USER: 'user'
};

// 默认管理员账户
const DEFAULT_ADMIN = {
  username: 'admin',
  password: hashPassword('admin123'),
  role: ROLES.ADMIN,
  createTime: new Date().toISOString(),
  lastLoginTime: null
};

// 初始化用户数据
const initUsers = () => {
  ensureDirectoryExists();
  if (!fs.existsSync(USER_FILE)) {
    fs.writeFileSync(USER_FILE, JSON.stringify([DEFAULT_ADMIN], null, 2));
  }
};

// 读取所有用户
const getUsers = () => {
  try {
    initUsers();
    const data = fs.readFileSync(USER_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('读取用户数据失败:', error);
    return [DEFAULT_ADMIN];
  }
};

// 保存用户数据
const saveUsers = (users) => {
  try {
    ensureDirectoryExists();
    fs.writeFileSync(USER_FILE, JSON.stringify(users, null, 2));
    return true;
  } catch (error) {
    console.error('保存用户数据失败:', error);
    return false;
  }
};

// 哈希密码
function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

// 验证用户登录
const verifyUser = (username, password) => {
  const users = getUsers();
  const user = users.find(u => u.username === username);
  if (!user) return null;
  
  const hashedPassword = hashPassword(password);
  if (user.password === hashedPassword) {
    // 更新最后登录时间
    user.lastLoginTime = new Date().toISOString();
    saveUsers(users);
    
    // 返回用户信息（不含密码）
    const { password, ...userInfo } = user;
    return userInfo;
  }
  return null;
};

// 添加新用户
const addUser = (userData) => {
  if (!userData.username || !userData.password) {
    return { success: false, message: '用户名和密码不能为空' };
  }
  
  const users = getUsers();
  
  // 检查用户名是否已存在
  if (users.some(u => u.username === userData.username)) {
    return { success: false, message: '用户名已存在' };
  }
  
  // 创建新用户
  const newUser = {
    username: userData.username,
    password: hashPassword(userData.password),
    role: userData.role || ROLES.USER,
    createTime: new Date().toISOString(),
    lastLoginTime: null
  };
  
  users.push(newUser);
  
  if (saveUsers(users)) {
    return { success: true, message: '用户创建成功' };
  } else {
    return { success: false, message: '用户创建失败，系统错误' };
  }
};

// 删除用户
const deleteUser = (username) => {
  const users = getUsers();
  
  // 防止删除最后一个管理员
  const admins = users.filter(u => u.role === ROLES.ADMIN);
  const targetUser = users.find(u => u.username === username);
  
  if (!targetUser) {
    return { success: false, message: '用户不存在' };
  }
  
  if (targetUser.role === ROLES.ADMIN && admins.length <= 1) {
    return { success: false, message: '无法删除唯一的管理员账户' };
  }
  
  const newUsers = users.filter(u => u.username !== username);
  
  if (saveUsers(newUsers)) {
    return { success: true, message: '用户删除成功' };
  } else {
    return { success: false, message: '用户删除失败，系统错误' };
  }
};

// 修改用户密码
const changePassword = (username, newPassword) => {
  const users = getUsers();
  const user = users.find(u => u.username === username);
  
  if (!user) {
    return { success: false, message: '用户不存在' };
  }
  
  user.password = hashPassword(newPassword);
  
  if (saveUsers(users)) {
    return { success: true, message: '密码修改成功' };
  } else {
    return { success: false, message: '密码修改失败，系统错误' };
  }
};

// 修改自己的密码（需要验证旧密码）
const changeOwnPassword = (username, oldPassword, newPassword) => {
  const users = getUsers();
  const user = users.find(u => u.username === username);
  
  if (!user) {
    return { success: false, message: '用户不存在' };
  }
  
  // 验证旧密码
  if (user.password !== hashPassword(oldPassword)) {
    return { success: false, message: '原密码不正确' };
  }
  
  user.password = hashPassword(newPassword);
  
  if (saveUsers(users)) {
    return { success: true, message: '密码修改成功' };
  } else {
    return { success: false, message: '密码修改失败，系统错误' };
  }
};

// 获取用户信息（不含密码）
const getUserInfo = (username) => {
  const users = getUsers();
  const user = users.find(u => u.username === username);
  
  if (!user) return null;
  
  const { password, ...userInfo } = user;
  return userInfo;
};

// 导出模块
module.exports = {
  ROLES,
  getUsers,
  verifyUser,
  addUser,
  deleteUser,
  changePassword,
  changeOwnPassword,
  getUserInfo,
  initUsers,
}; 