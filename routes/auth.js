import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { query } from '../db.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Enter a username and password.' });
  }

  try {
    const { rows } = await query(
      'SELECT * FROM app_user WHERE username = $1',
      [username]
    );
    const user = rows[0];
    const ok = user && (await bcrypt.compare(password, user.password_hash));

    if (!ok) {
      return res.status(401).json({ error: 'Wrong username or password.' });
    }

    const token = jwt.sign(
      { id: user.id, username: user.username, name: user.full_name },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '12h' }
    );

    res.json({
      token,
      user: { id: user.id, username: user.username, name: user.full_name },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not sign you in. Try again.' });
  }
});

// GET /api/auth/me  - who am I (used to restore a session)
router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

export default router;
