import './setup/no-world';
import 'reflect-metadata';
import assert from 'node:assert/strict';
import path from 'node:path';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { NestFactory } from '@nestjs/core';
import { createSuite } from '@journeyax/test-support';
import * as jaxIq from '@journeyax/jax-iq';
import { AppModule } from '../src/app.module';
import { HealthController } from '../src/health.controller';
import { startRefusal } from '../src/main';

/** The skeleton of the service: a health route, a start-up that refuses unless switched on, and a dependency graph that builds without listening. */
const suite = createSuite('jax-iq-service: the skeleton');

const WORKTREE = path.resolve(__dirname, '../../..');

async function main() {
  await suite.test('the health controller answers when constructed directly', () => {
    assert.deepEqual(new HealthController().health(), { status: 'ok', service: 'jax-iq-service' });
  });

  await suite.test('the health answer is on GET /health and GET /api/v1/jax-iq/health, and nowhere else', () => {
    const handler = HealthController.prototype.health;
    assert.deepEqual(Reflect.getMetadata(PATH_METADATA, handler), ['health', 'api/v1/jax-iq/health']);
    assert.equal(Reflect.getMetadata(METHOD_METADATA, handler), RequestMethod.GET);
    assert.equal(Reflect.getMetadata(PATH_METADATA, HealthController), '/');
    const routes = Object.getOwnPropertyNames(HealthController.prototype).filter((name) => name !== 'constructor');
    assert.deepEqual(routes, ['health']);
  });

  await suite.test('the app module builds its dependency graph without listening', async () => {
    assert.deepEqual(Reflect.getMetadata('controllers', AppModule), [HealthController]);
    const context = await NestFactory.createApplicationContext(AppModule, { logger: false });
    try {
      assert.ok(context.get(AppModule));
    } finally {
      await context.close();
    }
  });

  await suite.test('the service refuses to start unless JAX_IQ_ENABLED is exactly 1', () => {
    assert.match(startRefusal({}) ?? '', /JAX_IQ_ENABLED=1/);
    for (const value of ['', '0', 'true', 'yes', ' 1']) assert.ok(startRefusal({ JAX_IQ_ENABLED: value }), `"${value}" does not switch it on`);
    assert.equal(startRefusal({ JAX_IQ_ENABLED: '1' }), undefined);
  });

  await suite.test('@journeyax/jax-iq resolves from this service\'s tests, from this worktree\'s source', () => {
    assert.equal(typeof jaxIq, 'object');
    assert.ok(Object.keys(require.cache).includes(path.join(WORKTREE, 'packages/jax-iq/src/index.ts')));
  });

  suite.finish();
}

main().catch((error) => { console.error(error); process.exit(1); });
