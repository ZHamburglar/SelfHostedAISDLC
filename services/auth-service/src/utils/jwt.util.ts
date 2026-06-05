import jwt from 'jsonwebtoken';

const SECRET = process.env.JWT_SECRET || 'default-secret';

export const generateToken = (userId: string): string => {
  return jwt.sign({ userId }, SECRET, { expiresIn: '1h' });
};

export const verifyToken = (token: string): any => {
  try {
    return jwt.verify(token, SECRET);
  } catch (err) {
    throw new Error('Invalid token');
  }
};