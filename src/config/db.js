import mongoose from 'mongoose';
import { config } from './env.js';

// Hides any username:password part of a connection string before logging.
const maskUri = (uri) => uri.replace(/\/\/([^@/]+)@/, '//***:***@');

const explain = (error) => {
  switch (error.name) {
    case 'MongooseServerSelectionError':
      return (
        'Could not reach MongoDB. For MongoDB Atlas: add your IP address under Network Access ' +
        '(or 0.0.0.0/0 while testing) and check MONGODB_URI. For a local MongoDB: make sure it is running.'
      );
    case 'MongoParseError':
    case 'MongoAPIError':
      return 'MONGODB_URI is not a valid MongoDB connection string.';
    default:
      if (/auth/i.test(error.message)) {
        return 'MongoDB rejected the credentials in MONGODB_URI.';
      }
      return 'Unexpected database connection error.';
  }
};

export const connectDB = async () => {
  mongoose.connection.on('disconnected', () =>
    console.warn('[db] MongoDB disconnected.')
  );
  mongoose.connection.on('reconnected', () =>
    console.log('[db] MongoDB reconnected.')
  );
  mongoose.connection.on('error', (error) =>
    console.error(`[db] MongoDB error: ${error.message}`)
  );

  try {
    await mongoose.connect(config.mongoUri, {
      // Fail after 5 seconds instead of the 30-second default.
      serverSelectionTimeoutMS: 5000,
    });
    console.log(`[db] Connected to MongoDB (${mongoose.connection.name}).`);
  } catch (error) {
    console.error(`[db] Connection failed: ${explain(error)}`);
    console.error(`[db] Tried: ${maskUri(config.mongoUri)}`);
    console.error(`[db] Details: ${error.message}`);
    throw error;
  }
};

export const disconnectDB = () => mongoose.disconnect();

// Human-readable connection state used by the health check.
export const getDbState = () =>
  ['disconnected', 'connected', 'connecting', 'disconnecting'][
    mongoose.connection.readyState
  ] ?? 'unknown';
