'use strict';

const { expect } = require('chai');
const express = require('express');
const FormData = require('form-data');
const fs = require('fs-extra');
const { find, times } = require('lodash');
const md5 = require('md5');
const moment = require('moment');
const pMap = require('p-map');
const request = require('request-promise-native').defaults({
  resolveWithFullResponse: true,
});
const { URL, URLSearchParams } = require('url');

const { createServerAndClient, generateTestObjects } = require('../helpers');

describe('Operations on Objects', () => {
  let s3rver;
  let s3Client;
  const buckets = {
    // plain, unconfigured buckets
    plainA: {
      name: 'bucket-a',
    },
    plainB: {
      name: 'bucket-b',
    },
  };

  beforeEach(async () => {
    ({ s3rver, s3Client } = await createServerAndClient({
      configureBuckets: Object.values(buckets),
    }));
  });

  describe('Delete Multiple Objects', () => {
    it('deletes an image from a bucket', async function() {
      await s3Client
        .putObject({
          Bucket: 'bucket-a',
          Key: 'large',
          Body: Buffer.alloc(10),
        })
        .promise();
      await s3Client
        .deleteObject({ Bucket: 'bucket-a', Key: 'large' })
        .promise();
    });

    it('deletes 500 objects with deleteObjects', async function() {
      this.timeout(30000);
      await generateTestObjects(s3Client, 'bucket-a', 500);
      const deleteObj = { Objects: times(500, i => ({ Key: 'key' + i })) };
      const data = await s3Client
        .deleteObjects({ Bucket: 'bucket-a', Delete: deleteObj })
        .promise();
      expect(data.Deleted).to.exist;
      expect(data.Deleted).to.have.lengthOf(500);
      expect(find(data.Deleted, { Key: 'key67' })).to.exist;
    });

    it('reports invalid XML when using deleteObjects with zero objects', async function() {
      let error;
      try {
        await s3Client
          .deleteObjects({
            Bucket: 'bucket-a',
            Delete: { Objects: [] },
          })
          .promise();
      } catch (err) {
        error = err;
      }
      expect(error).to.exist;
      expect(error.code).to.equal('MalformedXML');
    });

    it('deletes nonexistent objects', async function() {
      const deleteObj = { Objects: [{ Key: 'doesnotexist' }] };
      const data = await s3Client
        .deleteObjects({ Bucket: 'bucket-a', Delete: deleteObj })
        .promise();
      expect(data.Deleted).to.exist;
      expect(data.Deleted).to.have.lengthOf(1);
      expect(find(data.Deleted, { Key: 'doesnotexist' })).to.exist;
    });
  });

  describe('DELETE Object', () => {
    it('deletes 500 objects', async function() {
      this.timeout(30000);
      await generateTestObjects(s3Client, 'bucket-a', 500);
      await pMap(
        times(500),
        i =>
          s3Client
            .deleteObject({ Bucket: 'bucket-a', Key: 'key' + i })
            .promise(),
        { concurrency: 100 },
      );
    });

    it('deletes a nonexistent object from a bucket', async function() {
      await s3Client
        .deleteObject({ Bucket: 'bucket-a', Key: 'doesnotexist' })
        .promise();
    });
  });

  describe('GET Object', () => {
    it('stores a large buffer in a bucket', async function() {
      const data = await s3Client
        .putObject({
          Bucket: 'bucket-a',
          Key: 'large',
          Body: Buffer.alloc(20 * Math.pow(1024, 2)),
        })
        .promise();
      expect(data.ETag).to.match(/"[a-fA-F0-9]{32}"/);
    });

    it('gets an image from a bucket', async function() {
      const file = require.resolve('../fixtures/image0.jpg');
      const data = await fs.readFile(file);
      await s3Client
        .putObject({
          Bucket: 'bucket-a',
          Key: 'image',
          Body: data,
          ContentType: 'image/jpeg',
        })
        .promise();
      const object = await s3Client
        .getObject({ Bucket: 'bucket-a', Key: 'image' })
        .promise();
      expect(object.ETag).to.equal(JSON.stringify(md5(data)));
      expect(object.ContentLength).to.equal(data.length);
      expect(object.ContentType).to.equal('image/jpeg');
    });

    it('can HEAD an empty object in a bucket', async function() {
      await s3Client
        .putObject({
          Bucket: 'bucket-a',
          Key: 'somekey',
          Body: '',
        })
        .promise();
      const object = await s3Client
        .headObject({ Bucket: 'bucket-a', Key: 'somekey' })
        .promise();
      expect(object.ETag).to.match(/"[a-fA-F0-9]{32}"/);
    });

    it('gets partial image from a bucket with a range request', async function() {
      const file = require.resolve('../fixtures/image0.jpg');
      await s3Client
        .putObject({
          Bucket: 'bucket-a',
          Key: 'image',
          Body: await fs.readFile(file),
          ContentType: 'image/jpeg',
        })
        .promise();
      const url = s3Client.getSignedUrl('getObject', {
        Bucket: 'bucket-a',
        Key: 'image',
      });
      const res = await request(url, {
        headers: { range: 'bytes=0-99' },
      });
      expect(res.statusCode).to.equal(206);
      expect(res.headers).to.have.property('content-range');
      expect(res.headers).to.have.property('accept-ranges');
      expect(res.headers).to.have.property('content-length', '100');
    });

    it('returns 416 error for out of bounds range requests', async function() {
      const file = require.resolve('../fixtures/image0.jpg');
      const filesize = fs.statSync(file).size;
      await s3Client
        .putObject({
          Bucket: 'bucket-a',
          Key: 'image',
          Body: await fs.readFile(file),
          ContentType: 'image/jpeg',
        })
        .promise();
      const url = s3Client.getSignedUrl('getObject', {
        Bucket: 'bucket-a',
        Key: 'image',
      });

      let error;
      try {
        await request(url, {
          headers: { range: `bytes=${filesize + 100}-${filesize + 200}` },
        });
      } catch (err) {
        error = err;
      }
      expect(error).to.exist;
      expect(error.response.statusCode).to.equal(416);
    });

    it('returns actual length of data for partial out of bounds range requests', async function() {
      const file = require.resolve('../fixtures/image0.jpg');
      const filesize = fs.statSync(file).size;
      await s3Client
        .putObject({
          Bucket: 'bucket-a',
          Key: 'image',
          Body: await fs.readFile(file),
          ContentType: 'image/jpeg',
        })
        .promise();
      const url = s3Client.getSignedUrl('getObject', {
        Bucket: 'bucket-a',
        Key: 'image',
      });
      const res = await request(url, {
        headers: { range: 'bytes=0-100000' },
      });
      expect(res.statusCode).to.equal(206);
      expect(res.headers).to.have.property('content-range');
      expect(res.headers).to.have.property('accept-ranges');
      expect(res.headers).to.have.property(
        'content-length',
        filesize.toString(),
      );
    });

    it('finds a text file in a multi directory path', async function() {
      await s3Client
        .putObject({
          Bucket: 'bucket-a',
          Key: 'multi/directory/path/text',
          Body: 'Hello!',
        })
        .promise();
      const object = await s3Client
        .getObject({
          Bucket: 'bucket-a',
          Key: 'multi/directory/path/text',
        })
        .promise();
      expect(object.ETag).to.equal(JSON.stringify(md5('Hello!')));
      expect(object.ContentLength).to.equal(6);
      expect(object.ContentType).to.equal('application/octet-stream');
    });

    it('returns image metadata from a bucket in HEAD request', async function() {
      const file = require.resolve('../fixtures/image0.jpg');
      const fileContent = await fs.readFile(file);
      await s3Client
        .putObject({
          Bucket: 'bucket-a',
          Key: 'image',
          Body: fileContent,
          ContentType: 'image/jpeg',
          ContentLength: fileContent.length,
        })
        .promise();
      const object = await s3Client
        .headObject({ Bucket: 'bucket-a', Key: 'image' })
        .promise();
      expect(object.ETag).to.equal(JSON.stringify(md5(fileContent)));
      expect(object.ContentLength).to.equal(fileContent.length);
      expect(object.ContentType).to.equal('image/jpeg');
    });

    it('fails to find an image from a bucket', async function() {
      let error;
      try {
        await s3Client
          .getObject({ Bucket: 'bucket-a', Key: 'image' })
          .promise();
      } catch (err) {
        error = err;
        expect(err.code).to.equal('NoSuchKey');
        expect(err.statusCode).to.equal(404);
      }
      expect(error).to.exist;
    });
  });

  describe('GET Object ACL', () => {
    it('returns a dummy acl for an object', async function() {
      const object = await s3Client
        .getObjectAcl({ Bucket: 'bucket-a', Key: 'image0' })
        .promise();
      expect(object.Owner.DisplayName).to.equal('S3rver');
    });
  });

  describe('GET Object tagging', () => {
    it("errors when getting tags for an object that doesn't exist", async function() {
      await expect(
        s3Client
          .getObjectTagging({
            Bucket: 'bucket-a',
            Key: 'text',
          })
          .promise(),
      ).to.eventually.be.rejectedWith('The specified key does not exist.');
    });

    it('returns an empty tag set for an untagged object', async function() {
      await s3Client
        .putObject({ Bucket: 'bucket-a', Key: 'text', Body: 'Hello!' })
        .promise();

      const tagging = await s3Client
        .getObjectTagging({
          Bucket: 'bucket-a',
          Key: 'text',
        })
        .promise();

      expect(tagging).to.eql({ TagSet: [] });
    });
  });

  describe('POST Object', () => {
    it('stores a text object for a multipart/form-data request', async function() {
      const form = new FormData();
      form.append('key', 'text');
      form.append('file', 'Hello!', 'post_file.txt');
      const res = await request.post('bucket-a', {
        baseUrl: s3Client.config.endpoint,
        body: form,
        headers: form.getHeaders(),
      });
      expect(res.statusCode).to.equal(204);
      const object = await s3Client
        .getObject({ Bucket: 'bucket-a', Key: 'text' })
        .promise();
      expect(object.ContentType).to.equal('binary/octet-stream');
      expect(object.Body).to.deep.equal(Buffer.from('Hello!'));
    });

    it('rejects requests with an invalid content-type', async function() {
      let res;
      try {
        res = await request.post('bucket-a', {
          baseUrl: s3Client.config.endpoint,
          body: new URLSearchParams({
            key: 'text',
            file: 'Hello!',
          }).toString(),
        });
      } catch (err) {
        res = err.response;
      }
      expect(res.statusCode).to.equal(412);
      expect(res.body).to.contain(
        '<Condition>Bucket POST must be of the enclosure-type multipart/form-data</Condition>',
      );
    });
    it('stores a text object without filename part metadata', async function() {
      const form = new FormData();
      form.append('key', 'text');
      form.append('file', 'Hello!');
      const res = await request.post('bucket-a', {
        baseUrl: s3Client.config.endpoint,
        body: form,
        headers: form.getHeaders(),
      });
      expect(res.statusCode).to.equal(204);
      const object = await s3Client
        .getObject({ Bucket: 'bucket-a', Key: 'text' })
        .promise();
      expect(object.ContentType).to.equal('binary/octet-stream');
      expect(object.Body.toString()).to.equal('Hello!');
    });

    it('stores a text object with a content-type', async function() {
      const form = new FormData();
      form.append('key', 'text');
      form.append('Content-Type', 'text/plain');
      form.append('file', 'Hello!', 'post_file.txt');
      const res = await request.post('bucket-a', {
        baseUrl: s3Client.config.endpoint,
        body: form,
        headers: form.getHeaders(),
      });
      expect(res.statusCode).to.equal(204);
      const object = await s3Client
        .getObject({ Bucket: 'bucket-a', Key: 'text' })
        .promise();
      expect(object.ContentType).to.equal('text/plain');
      expect(object.Body).to.deep.equal(Buffer.from('Hello!'));
    });

    it('returns the location of the stored object in a header', async function() {
      const file = require.resolve('../fixtures/image0.jpg');
      const form = new FormData();
      form.append('key', 'image');
      form.append('file', fs.createReadStream(file));
      const res = await request.post('bucket-a', {
        baseUrl: s3Client.config.endpoint,
        body: form,
        headers: form.getHeaders(),
      });
      expect(res.statusCode).to.equal(204);
      expect(res.headers).to.have.property(
        'location',
        new URL('/bucket-a/image', s3Client.config.endpoint).href,
      );
      const objectRes = await request(res.headers.location, {
        encoding: null,
      });
      expect(objectRes.body).to.deep.equal(fs.readFileSync(file));
    });

    it('returns the location of the stored object in a header with vhost URL', async function() {
      const file = require.resolve('../fixtures/image0.jpg');
      const form = new FormData();
      form.append('key', 'image');
      form.append('file', fs.createReadStream(file));
      const res = await request.post('', {
        baseUrl: s3Client.config.endpoint,
        body: form,
        headers: {
          host: 'bucket-a',
          ...form.getHeaders(),
        },
      });
      expect(res.statusCode).to.equal(204);
      expect(res.headers).to.have.property(
        'location',
        new URL('/image', `http://bucket-a`).href,
      );
    });

    it('returns the location of the stored object in a header with subdomain URL', async function() {
      const file = require.resolve('../fixtures/image0.jpg');
      const form = new FormData();
      form.append('key', 'image');
      form.append('file', fs.createReadStream(file));
      const res = await request.post('', {
        baseUrl: s3Client.config.endpoint,
        body: form,
        headers: {
          host: 'bucket-a.s3.amazonaws.com',
          ...form.getHeaders(),
        },
      });
      expect(res.statusCode).to.equal(204);
      expect(res.headers).to.have.property(
        'location',
        new URL('/image', 'http://bucket-a.s3.amazonaws.com').href,
      );
    });

    it('returns a 200 status code with empty response body', async function() {
      const form = new FormData();
      form.append('key', 'text');
      form.append('success_action_status', '200');
      form.append('file', 'Hello!');
      const res = await request.post('bucket-a', {
        baseUrl: s3Client.config.endpoint,
        body: form,
        headers: form.getHeaders(),
      });
      expect(res.statusCode).to.equal(200);
      expect(res.headers).not.to.have.property('content-type');
      expect(res.body).to.equal('');
    });

    it('returns a 201 status code with XML response body', async function() {
      const form = new FormData();
      form.append('key', 'text');
      form.append('success_action_status', '201');
      form.append('file', 'Hello!');
      const res = await request.post('bucket-a', {
        baseUrl: s3Client.config.endpoint,
        body: form,
        headers: form.getHeaders(),
      });
      expect(res.statusCode).to.equal(201);
      expect(res.headers).to.have.property('content-type', 'application/xml');
      expect(res.body).to.contain('<PostResponse>');
      expect(res.body).to.contain('<Bucket>bucket-a</Bucket><Key>text</Key>');
    });

    it('returns a 204 status code when an invalid status is specified', async function() {
      const form = new FormData();
      form.append('key', 'text');
      form.append('success_action_status', '301');
      form.append('file', 'Hello!');
      const res = await request.post('bucket-a', {
        baseUrl: s3Client.config.endpoint,
        body: form,
        headers: form.getHeaders(),
      });
      expect(res.statusCode).to.equal(204);
    });

    it('redirects a custom location with search parameters', async function() {
      const successRedirect = new URL('http://foo.local/path?bar=baz');
      const form = new FormData();
      form.append('key', 'text');
      form.append('success_action_redirect', successRedirect.href);
      form.append('file', 'Hello!');
      let res;
      try {
        res = await request.post('bucket-a', {
          baseUrl: s3Client.config.endpoint,
          body: form,
          headers: form.getHeaders(),
        });
      } catch (err) {
        res = err.response;
      }
      expect(res.statusCode).to.equal(303);
      const location = new URL(res.headers.location);
      expect(location.host).to.equal(successRedirect.host);
      expect(location.pathname).to.equal(successRedirect.pathname);
      expect(new Map(location.searchParams)).to.contain.key('bar');
      expect(location.searchParams.get('bucket')).to.equal('bucket-a');
      expect(location.searchParams.get('key')).to.equal('text');
      expect(location.searchParams.get('etag')).to.equal(
        JSON.stringify(md5('Hello!')),
      );
    });

    it('redirects a custom location using deprecated redirect fieldname', async function() {
      const successRedirect = new URL('http://foo.local/path?bar=baz');
      const form = new FormData();
      form.append('key', 'text');
      form.append('redirect', successRedirect.href);
      form.append('file', 'Hello!');
      let res;
      try {
        res = await request.post('bucket-a', {
          baseUrl: s3Client.config.endpoint,
          body: form,
          headers: form.getHeaders(),
        });
      } catch (err) {
        res = err.response;
      }
      expect(res.statusCode).to.equal(303);
      const location = new URL(res.headers.location);
      expect(location.host).to.equal(successRedirect.host);
      expect(location.pathname).to.equal(successRedirect.pathname);
    });

    it('ignores deprecated redirect field when success_action_redirect is specified', async function() {
      const successRedirect = new URL('http://foo.local/path?bar=baz');
      const form = new FormData();
      form.append('key', 'text');
      form.append('success_action_redirect', successRedirect.href);
      form.append('redirect', 'http://ignore-me.local');
      form.append('file', 'Hello!');
      let res;
      try {
        res = await request.post('bucket-a', {
          baseUrl: s3Client.config.endpoint,
          body: form,
          headers: form.getHeaders(),
        });
      } catch (err) {
        res = err.response;
      }
      expect(res.statusCode).to.equal(303);
      const location = new URL(res.headers.location);
      expect(location.host).to.equal(successRedirect.host);
      expect(location.pathname).to.equal(successRedirect.pathname);
    });

    it('ignores status field when redirect is specified', async function() {
      const successRedirect = new URL('http://foo.local/path?bar=baz');
      const form = new FormData();
      form.append('key', 'text');
      form.append('success_action_redirect', successRedirect.href);
      form.append('success_action_status', '200');
      form.append('file', 'Hello!');
      let res;
      try {
        res = await request.post('bucket-a', {
          baseUrl: s3Client.config.endpoint,
          body: form,
          headers: form.getHeaders(),
        });
      } catch (err) {
        res = err.response;
      }
      expect(res.statusCode).to.equal(303);
    });

    it('ignores fields specified after the file field', async function() {
      const form = new FormData();
      form.append('key', 'text');
      form.append('file', 'Hello!');
      form.append('Content-Type', 'text/plain');
      form.append('success_action_status', '200');
      const res = await request.post('bucket-a', {
        baseUrl: s3Client.config.endpoint,
        body: form,
        headers: form.getHeaders(),
      });
      const objectRes = await request(res.headers.location, {
        encoding: null,
      });
      expect(res.statusCode).to.equal(204);
      expect(objectRes.headers).to.not.have.property(
        'content-type',
        'text/plain',
      );
    });

    it('rejects requests with no key field', async function() {
      const form = new FormData();
      form.append('file', 'Hello!');
      let res;
      try {
        res = await request.post('bucket-a', {
          baseUrl: s3Client.config.endpoint,
          body: form,
          headers: form.getHeaders(),
        });
      } catch (err) {
        res = err.response;
      }
      expect(res.statusCode).to.equal(400);
      expect(res.body).to.contain(
        '<ArgumentName>key</ArgumentName><ArgumentValue></ArgumentValue>',
      );
    });

    it('rejects requests with zero-length key', async function() {
      const form = new FormData();
      form.append('key', '');
      form.append('file', 'Hello!');
      let res;
      try {
        res = await request.post('bucket-a', {
          baseUrl: s3Client.config.endpoint,
          body: form,
          headers: form.getHeaders(),
        });
      } catch (err) {
        res = err.response;
      }
      expect(res.statusCode).to.equal(400);
      expect(res.body).to.contain(
        '<Message>User key must have a length greater than 0.</Message>',
      );
    });

    it('rejects requests with no file field', async function() {
      const form = new FormData();
      form.append('key', 'text');
      let res;
      try {
        res = await request.post('bucket-a', {
          baseUrl: s3Client.config.endpoint,
          body: form,
          headers: form.getHeaders(),
        });
      } catch (err) {
        res = err.response;
      }
      expect(res.statusCode).to.equal(400);
      expect(res.body).to.contain(
        '<ArgumentName>file</ArgumentName><ArgumentValue>0</ArgumentValue>',
      );
    });
  });

  describe('PUT Object', () => {
    it('stores a text object in a bucket', async function() {
      const data = await s3Client
        .putObject({ Bucket: 'bucket-a', Key: 'text', Body: 'Hello!' })
        .promise();
      expect(data.ETag).to.match(/"[a-fA-F0-9]{32}"/);
    });

    it('stores a different image and update the previous image', async function() {
      const files = [
        require.resolve('../fixtures/image0.jpg'),
        require.resolve('../fixtures/image1.jpg'),
      ];

      // Get object from store
      await s3Client
        .putObject({
          Bucket: 'bucket-a',
          Key: 'image',
          Body: await fs.readFile(files[0]),
          ContentType: 'image/jpeg',
        })
        .promise();
      const object = await s3Client
        .getObject({ Bucket: 'bucket-a', Key: 'image' })
        .promise();

      // Store different object
      const storedObject = await s3Client
        .putObject({
          Bucket: 'bucket-a',
          Key: 'image',
          Body: await fs.readFile(files[1]),
          ContentType: 'image/jpeg',
        })
        .promise();
      expect(storedObject.ETag).to.not.equal(object.ETag);

      // Get object again and do some comparisons
      const newObject = await s3Client
        .getObject({ Bucket: 'bucket-a', Key: 'image' })
        .promise();
      expect(newObject.LastModified).to.not.equal(object.LastModified);
      expect(newObject.ContentLength).to.not.equal(object.ContentLength);
    });

    it('distinguishes keys stored with and without a trailing /', async function() {
      await s3Client
        .putObject({ Bucket: 'bucket-a', Key: 'text', Body: 'Hello!' })
        .promise();
      await s3Client
        .putObject({
          Bucket: 'bucket-a',
          Key: 'text/',
          Body: 'Goodbye!',
        })
        .promise();
      const obj1 = await s3Client
        .getObject({ Bucket: 'bucket-a', Key: 'text' })
        .promise();
      const obj2 = await s3Client
        .getObject({ Bucket: 'bucket-a', Key: 'text/' })
        .promise();
      expect(obj1.Body.toString()).to.equal('Hello!');
      expect(obj2.Body.toString()).to.equal('Goodbye!');
    });

    it('stores a text object with invalid win32 path characters and retrieves it', async function() {
      const reservedChars = '\\/:*?"<>|';
      await s3Client
        .putObject({
          Bucket: 'bucket-a',
          Key: `mykey-&-${reservedChars}`,
          Body: 'Hello!',
        })
        .promise();

      const object = await s3Client
        .getObject({
          Bucket: 'bucket-a',
          Key: `mykey-&-${reservedChars}`,
        })
        .promise();

      expect(object.Body.toString()).to.equal('Hello!');
    });

    it('stores a text object with no content type and retrieves it', async function() {
      const res = await request.put('bucket-a/text', {
        baseUrl: s3Client.config.endpoint,
        body: 'Hello!',
      });
      expect(res.statusCode).to.equal(200);
      const data = await s3Client
        .getObject({ Bucket: 'bucket-a', Key: 'text' })
        .promise();
      expect(data.ContentType).to.equal('binary/octet-stream');
    });

    it('stores a text object with some custom metadata', async function() {
      const data = await s3Client
        .putObject({
          Bucket: 'bucket-a',
          Key: 'textmetadata',
          Body: 'Hello!',
          Metadata: {
            someKey: 'value',
          },
        })
        .promise();
      expect(data.ETag).to.match(/"[a-fA-F0-9]{32}"/);
      const object = await s3Client
        .getObject({ Bucket: 'bucket-a', Key: 'textmetadata' })
        .promise();
      expect(object.Metadata.somekey).to.equal('value');
    });

    it('stores an image in a bucket', async function() {
      const file = require.resolve('../fixtures/image0.jpg');
      const data = await s3Client
        .putObject({
          Bucket: 'bucket-a',
          Key: 'image',
          Body: await fs.readFile(file),
          ContentType: 'image/jpeg',
        })
        .promise();
      expect(data.ETag).to.match(/"[a-fA-F0-9]{32}"/);
    });

    it('stores a file in bucket with gzip encoding', async function() {
      const file = require.resolve('../fixtures/jquery.js.gz');

      const params = {
        Bucket: 'bucket-a',
        Key: 'jquery',
        Body: await fs.readFile(file),
        ContentType: 'application/javascript',
        ContentEncoding: 'gzip',
      };

      await s3Client.putObject(params).promise();
      const object = await s3Client
        .getObject({ Bucket: 'bucket-a', Key: 'jquery' })
        .promise();
      expect(object.ContentEncoding).to.equal('gzip');
      expect(object.ContentType).to.equal('application/javascript');
    });

    it('stores and retrieves an object while mounted on a subpath', async function() {
      const app = express();
      app.use('/basepath', s3rver.getMiddleware());

      const { httpServer } = s3rver;
      httpServer.removeAllListeners('request');
      httpServer.on('request', app);
      s3Client.setEndpoint(
        `${s3Client.endpoint.protocol}//localhost:${s3Client.endpoint.port}/basepath`,
      );

      await s3Client
        .putObject({
          Bucket: 'bucket-a',
          Key: 'text',
          Body: 'Hello!',
        })
        .promise();
      const object = await s3Client
        .getObject({ Bucket: 'bucket-a', Key: 'text' })
        .promise();
      expect(object.Body.toString()).to.equal('Hello!');
    });

    it('stores an object in a bucket after all objects are deleted', async function() {
      const bucket = 'foobars';
      await s3Client.createBucket({ Bucket: bucket }).promise();
      await s3Client
        .putObject({ Bucket: bucket, Key: 'foo.txt', Body: 'Hello!' })
        .promise();
      await s3Client.deleteObject({ Bucket: bucket, Key: 'foo.txt' }).promise();
      await s3Client
        .putObject({ Bucket: bucket, Key: 'foo2.txt', Body: 'Hello2!' })
        .promise();
    });
  });

  describe('PUT Object - Copy', () => {
    it('copies an image object into another bucket', async function() {
      const srcKey = 'image';
      const destKey = 'image/jamie';

      const file = require.resolve('../fixtures/image0.jpg');
      const data = await s3Client
        .putObject({
          Bucket: 'bucket-a',
          Key: srcKey,
          Body: await fs.readFile(file),
          ContentType: 'image/jpeg',
        })
        .promise();
      expect(data.ETag).to.match(/"[a-fA-F0-9]{32}"/);
      const copyResult = await s3Client
        .copyObject({
          Bucket: 'bucket-b',
          Key: destKey,
          CopySource: '/bucket-a/' + srcKey,
        })
        .promise();
      expect(copyResult.ETag).to.equal(data.ETag);
      expect(moment(copyResult.LastModified).isValid()).to.be.true;
      const object = await s3Client
        .getObject({
          Bucket: 'bucket-b',
          Key: destKey,
        })
        .promise();
      expect(object.ETag).to.equal(data.ETag);
    });

    it('copies an image object into another bucket including its metadata', async function() {
      const srcKey = 'image';
      const destKey = 'image/jamie';

      const file = require.resolve('../fixtures/image0.jpg');
      const data = await s3Client
        .putObject({
          Bucket: 'bucket-a',
          Key: srcKey,
          Body: await fs.readFile(file),
          ContentType: 'image/jpeg',
          Metadata: {
            someKey: 'value',
          },
        })
        .promise();
      expect(data.ETag).to.match(/"[a-fA-F0-9]{32}"/);
      await s3Client
        .copyObject({
          Bucket: 'bucket-b',
          Key: destKey,
          // MetadataDirective is implied to be COPY
          CopySource: '/bucket-a/' + srcKey,
        })
        .promise();
      const object = await s3Client
        .getObject({ Bucket: 'bucket-b', Key: destKey })
        .promise();
      expect(object.Metadata).to.have.property('somekey', 'value');
      expect(object.ContentType).to.equal('image/jpeg');
      expect(object.ETag).to.equal(data.ETag);
    });

    it('copies an object using spaces/unicode chars in keys', async function() {
      const srcKey = 'awesome 驚くばかり.jpg';
      const destKey = 'new 新しい.jpg';

      const file = require.resolve('../fixtures/image0.jpg');
      const data = await s3Client
        .putObject({
          Bucket: 'bucket-a',
          Key: srcKey,
          Body: await fs.readFile(file),
          ContentType: 'image/jpeg',
        })
        .promise();
      expect(data.ETag).to.match(/"[a-fA-F0-9]{32}"/);
      const copyResult = await s3Client
        .copyObject({
          Bucket: 'bucket-a',
          Key: destKey,
          CopySource: '/bucket-a/' + encodeURI(srcKey),
        })
        .promise();
      expect(copyResult.ETag).to.equal(data.ETag);
      expect(moment(copyResult.LastModified).isValid()).to.be.true;
    });

    it('copies an image object into another bucket and update its metadata', async function() {
      const srcKey = 'image';
      const destKey = 'image/jamie';

      const file = require.resolve('../fixtures/image0.jpg');
      await s3Client
        .putObject({
          Bucket: 'bucket-a',
          Key: srcKey,
          Body: await fs.readFile(file),
          ContentType: 'image/jpeg',
        })
        .promise();
      await s3Client
        .copyObject({
          Bucket: 'bucket-b',
          Key: destKey,
          CopySource: '/bucket-a/' + srcKey,
          MetadataDirective: 'REPLACE',
          Metadata: {
            someKey: 'value',
          },
        })
        .promise();
      const object = await s3Client
        .getObject({ Bucket: 'bucket-b', Key: destKey })
        .promise();
      expect(object.Metadata.somekey).to.equal('value');
      expect(object.ContentType).to.equal('application/octet-stream');
    });

    it('updates the metadata of an image object', async function() {
      const srcKey = 'image';
      const destKey = 'image/jamie';

      const file = require.resolve('../fixtures/image0.jpg');
      const data = await s3Client
        .putObject({
          Bucket: 'bucket-a',
          Key: srcKey,
          Body: await fs.readFile(file),
          ContentType: 'image/jpeg',
        })
        .promise();
      expect(data.ETag).to.match(/"[a-fA-F0-9]{32}"/);
      await s3Client
        .copyObject({
          Bucket: 'bucket-b',
          Key: destKey,
          CopySource: '/bucket-a/' + srcKey,
          MetadataDirective: 'REPLACE',
          Metadata: {
            someKey: 'value',
          },
        })
        .promise();
      const object = await s3Client
        .getObject({ Bucket: 'bucket-b', Key: destKey })
        .promise();
      expect(object.Metadata).to.have.property('somekey', 'value');
      expect(object.ContentType).to.equal('application/octet-stream');
    });

    it('fails to update the metadata of an image object when no REPLACE MetadataDirective is specified', async function() {
      const key = 'image';

      const file = require.resolve('../fixtures/image0.jpg');
      const data = await s3Client
        .putObject({
          Bucket: 'bucket-a',
          Key: key,
          Body: await fs.readFile(file),
          ContentType: 'image/jpeg',
        })
        .promise();
      expect(data.ETag).to.match(/"[a-fA-F0-9]{32}"/);
      let error;
      try {
        await s3Client
          .copyObject({
            Bucket: 'bucket-a',
            Key: key,
            CopySource: '/bucket-a/' + key,
            Metadata: {
              someKey: 'value',
            },
          })
          .promise();
      } catch (err) {
        error = err;
        expect(err.statusCode).to.equal(400);
      }
      expect(error).to.exist;
    });

    it('fails to copy an image object because the object does not exist', async function() {
      let error;
      try {
        await s3Client
          .copyObject({
            Bucket: 'bucket-b',
            Key: 'image/jamie',
            CopySource: '/bucket-a/doesnotexist',
          })
          .promise();
      } catch (err) {
        error = err;
        expect(err.code).to.equal('NoSuchKey');
        expect(err.statusCode).to.equal(404);
      }
      expect(error).to.exist;
    });

    it('fails to copy an image object because the source bucket does not exist', async function() {
      let error;
      try {
        await s3Client
          .copyObject({
            Bucket: 'bucket-b',
            Key: 'image/jamie',
            CopySource: '/falsebucket/doesnotexist',
          })
          .promise();
      } catch (err) {
        error = err;
        expect(err.code).to.equal('NoSuchBucket');
        expect(err.statusCode).to.equal(404);
      }
      expect(error).to.exist;
    });
  });

  describe('PUT Object tagging', () => {
    it('tags an object in a bucket', async function() {
      await s3Client
        .putObject({ Bucket: 'bucket-a', Key: 'text', Body: 'Hello!' })
        .promise();

      await s3Client
        .putObjectTagging({
          Bucket: 'bucket-a',
          Key: 'text',
          Tagging: { TagSet: [{ Key: 'Test', Value: 'true' }] },
        })
        .promise();

      const tagging = await s3Client
        .getObjectTagging({
          Bucket: 'bucket-a',
          Key: 'text',
        })
        .promise();

      expect(tagging).to.eql({ TagSet: [{ Key: 'Test', Value: 'true' }] });
    });

    it("errors when tagging an object that doesn't exist", async function() {
      await expect(
        s3Client
          .putObjectTagging({
            Bucket: 'bucket-a',
            Key: 'text',
            Tagging: { TagSet: [{ Key: 'Test', Value: 'true' }] },
          })
          .promise(),
      ).to.eventually.be.rejectedWith('The specified key does not exist.');
    });
  });

  describe('Initiate/Upload/Complete Multipart upload', () => {
    it('uploads a text file to a multi directory path', async function() {
      const data = await s3Client
        .putObject({
          Bucket: 'bucket-a',
          Key: 'multi/directory/path/text',
          Body: 'Hello!',
        })
        .promise();
      expect(data.ETag).to.match(/"[a-fA-F0-9]{32}"/);
    });

    it('completes a managed upload <=5MB', async function() {
      const data = await s3Client
        .upload({
          Bucket: 'bucket-a',
          Key: 'multi/directory/path/multipart',
          Body: Buffer.alloc(2 * Math.pow(1024, 2)), // 2MB
        })
        .promise();
      expect(data.ETag).to.match(/"[a-fA-F0-9]{32}"/);
    });

    it('completes a managed upload >5MB (multipart upload)', async function() {
      const data = await s3Client
        .upload({
          Bucket: 'bucket-a',
          Key: 'multi/directory/path/multipart',
          Body: Buffer.alloc(20 * Math.pow(1024, 2)), // 20MB
        })
        .promise();
      expect(data.ETag).to.match(/"[a-fA-F0-9]{32}"/);
    });

    it('completes a multipart upload with unquoted ETags', async function() {
      const data = await s3Client
        .createMultipartUpload({
          Bucket: 'bucket-a',
          Key: 'multi/directory/path/multipart',
        })
        .promise();
      const partRes = await s3Client
        .uploadPart({
          Body: 'Hello!',
          PartNumber: 1,
          ...data,
        })
        .promise();
      await s3Client
        .completeMultipartUpload({
          MultipartUpload: {
            Parts: [
              {
                PartNumber: 1,
                ETag: JSON.parse(partRes.ETag),
              },
            ],
          },
          ...data,
        })
        .promise();
    });

    it('completes a multipart upload with metadata', async function() {
      const data = await s3Client
        .upload({
          Bucket: 'bucket-a',
          Key: 'multi/directory/path/multipart',
          Body: Buffer.alloc(20 * Math.pow(1024, 2)), // 20MB
          Metadata: {
            someKey: 'value',
          },
        })
        .promise();
      expect(data.ETag).to.match(/"[a-fA-F0-9]{32}"/);
      const object = await s3Client
        .getObject({
          Bucket: 'bucket-a',
          Key: 'multi/directory/path/multipart',
        })
        .promise();
      expect(object.Metadata.somekey).to.equal('value');
    });
  });
});
