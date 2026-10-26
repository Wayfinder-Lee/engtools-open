'use strict';

/** 密码哈希与 JWT 会话。 */

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const config = require('./config');

const SALT_ROUNDS = 10;

function hashPassword(password) {
  return bcrypt.hashSync(password, SALT_ROUNDS);
}

function verifyPassword(password, hash) {
  if (!hash) return false;
  return bcrypt.compareSync(password, hash);
}

/** 签发会话 token。expiresIn 缺省沿用 JWT_EXPIRES_IN（30 天）。 */
function signToken(email, expiresIn) {
  return jwt.sign({ email }, config.jwtSecret, { expiresIn: expiresIn || config.jwtExpiresIn });
}

/** 校验请求头里的 Bearer token，返回 email；无效返回 null。 */
function verifyToken(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice('Bearer '.length).trim();
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    return payload && payload.email ? payload.email : null;
  } catch (_err) {
    return null;
  }
}

module.exports = { hashPassword, verifyPassword, signToken, verifyToken };
