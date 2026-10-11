// lib/mongo.ts refuses to load without MONGODB_URI. The client only connects
// on first use, and the sync tests replace every collection accessor, so a
// dummy URI never gets dialled. Imported first by tests that load lib/sync.
process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:1/test';
