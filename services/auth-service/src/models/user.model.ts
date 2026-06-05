import bcrypt from 'bcrypt';

interface User {
  id: string;
  email: string;
  password: string;
}

const users: User[] = [];

export const createUser = async (email: string, password: string): Promise<User> => {
  const hashedPassword = await bcrypt.hash(password, 10);
  const user: User = { id: Date.now().toString(), email, password: hashedPassword };
  users.push(user);
  return user;
};

export const findUserByEmail = async (email: string): Promise<User | undefined> => {
  return users.find(u => u.email === email);
};

export const comparePassword = async (password: string, hashedPassword: string): Promise<boolean> => {
  return bcrypt.compare(password, hashedPassword);
};