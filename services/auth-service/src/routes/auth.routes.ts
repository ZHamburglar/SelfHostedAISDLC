import { Router } from 'express';

const router = Router();

router.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

router.get('/hello-world', (req, res) => {
  res.status(200).json({ message: 'Hello World' });
});

export default router;