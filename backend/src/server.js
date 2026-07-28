const http = require('http');
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const path = require('path');
const config = require('../config/config');
const { initDB } = require('../database/db');
const db = require('../database/db');

async function main() {
  await initDB();
  console.log('Database initialized.');

  const app = express();
  app.use(cors({ origin: true, credentials: true }));
  app.use(cookieParser());
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));
  app.use(express.static(path.join(__dirname, '../../frontend')));
  app.use('/uploads', express.static(path.join(__dirname, '../../data/uploads')));

  const authRoutes = require('../routes/auth');
  const problemRoutes = require('../routes/problems');
  const submissionRoutes = require('../routes/submissions');
  const ideRoutes = require('../routes/ide');
  const userRoutes = require('../routes/users');
  const languageRoutes = require('../routes/languages');
  const contestRoutes = require('../routes/contests');
  const articleRoutes = require('../routes/articles');
  const uploadRoutes = require('../routes/uploads');
  const tagRoutes = require('../routes/tags');
  const categoryRoutes = require('../routes/categories');

  app.use('/api/v1/auth', authRoutes);
  app.use('/api/v1/problems', problemRoutes);
  app.use('/api/v1/submissions', submissionRoutes);
  app.use('/api/v1/ide', ideRoutes);
  app.use('/api/v1/users', userRoutes);
  app.use('/api/v1/languages', languageRoutes);
  app.use('/api/v1/contests', contestRoutes);
  app.use('/api/v1/articles', articleRoutes);
  app.use('/api/v1/uploads', uploadRoutes);
  app.use('/api/v1/tags', tagRoutes);
  app.use('/api/v1/categories', categoryRoutes);

  app.get('/api/v1/stats', (req, res) => {
    const problems = db.prepare('SELECT COUNT(*) as c FROM problems WHERE is_public = 1').get().c;
    const submissions = db.prepare('SELECT COUNT(*) as c FROM submissions').get().c;
    const users = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
    const languages = db.prepare('SELECT COUNT(*) as c FROM languages WHERE is_enabled = 1').get().c;
    res.json({ problems, submissions, users, languages });
  });

  app.get('/api/v1/jobs', (req, res) => res.redirect('/api/v1/submissions'));
  app.get('/api/v1/jobs/:id', (req, res) => res.redirect(`/api/v1/submissions/${req.params.id}`));

  app.get('*', (req, res) => {
    if (req.path.startsWith('/api/')) {
      return res.status(404).json({ code: 3, reason: 'ERR_NOT_FOUND', message: 'API endpoint not found.' });
    }
    res.sendFile(path.join(__dirname, '../../frontend/pages/index.html'));
  });

  app.use((err, req, res, next) => {
    console.error('Server Error:', err);
    res.status(500).json({ code: 2, reason: 'ERR_INVALID_STATE', message: 'Internal server error.' });
  });

  const server = http.createServer(app);
  server.listen(config.port, () => {
    console.log(`WinOJ Server running on http://localhost:${config.port}`);
    console.log(`Protocol: HTTP/1.1 (HTTP/2 disabled for security)`);
    console.log(`Default admin: admin / admin123`);
  });
}

main().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
