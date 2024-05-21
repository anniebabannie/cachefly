import { S3Client } from '@aws-sdk/client-s3';

const Tigris = new S3Client({ 
  region: 'auto',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!
  },
});

export default Tigris;