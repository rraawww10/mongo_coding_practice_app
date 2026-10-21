'use strict';

const { ConnectionManager, classifyConnectionError } = require('../../src/connections/connectionManager');

const config = {
  atlasAllowedHostSuffixes: ['.mongodb.net'],
  atlasConnectTimeoutMs: 1000,
  atlasIdleCloseMs: 1000,
  credentialEncryptionKey: 'cd'.repeat(32),
  mongoAdminUri: 'mongodb://127.0.0.1:27017',
};

/** Fake MongoClient whose behaviour is scripted per test. */
function fakeClientFactory(behaviour = {}) {
  const created = [];
  const factory = (uri, opts) => {
    const client = {
      uri,
      opts,
      closed: false,
      connect: jest.fn(async () => {
        if (behaviour.connectError) throw behaviour.connectError;
      }),
      close: jest.fn(async () => {
        client.closed = true;
      }),
      db: jest.fn(() => ({
        command: jest.fn(async (cmd) => {
          if (cmd.connectionStatus) return { authInfo: { authenticatedUserRoles: behaviour.roles || [{ role: 'readWrite', db: 'practice' }] } };
          return { ok: 1 };
        }),
        listCollections: () => ({ toArray: async () => (behaviour.collections || []).map((name) => ({ name })) }),
      })),
    };
    created.push(client);
    return client;
  };
  factory.created = created;
  return factory;
}

const makeManager = (behaviour) => {
  const clientFactory = fakeClientFactory(behaviour);
  const mgr = new ConnectionManager({ config, mongo: { ping: async () => true }, clientFactory });
  return { mgr, clientFactory };
};

afterEach(() => jest.clearAllMocks());

describe('Atlas URL validation', () => {
  const { mgr } = makeManager();
  afterAll(() => mgr.closeAll());

  test('accepts a valid Atlas SRV URL with separate username/password fields', () => {
    const r = mgr.validateAtlasInput({
      connectionUrl: 'mongodb+srv://<username>:<password>@cluster0.abcde.mongodb.net/?retryWrites=true&w=majority',
      username: 'student1',
      password: 'p@ss:w/rd',
      database: 'practice',
    });
    expect(r.host).toBe('cluster0.abcde.mongodb.net');
    expect(r.database).toBe('practice');
    expect(r.uri).toContain('student1:p%40ss%3Aw%2Frd@');
    expect(r.usernameHint).toBe('st***');
  });

  test('accepts credentials and database embedded in the URL', () => {
    const r = mgr.validateAtlasInput({ connectionUrl: 'mongodb+srv://alice:secret@cluster0.x.mongodb.net/mydb' });
    expect(r.database).toBe('mydb');
  });

  test.each([
    ['http://cluster0.x.mongodb.net', 'INVALID_URL'],
    ['not a url', 'INVALID_URL'],
    ['', 'INVALID_URL'],
    ['mongodb+srv://', 'INVALID_URL'],
  ])('rejects invalid URL %p', (connectionUrl, code) => {
    expect(() => mgr.validateAtlasInput({ connectionUrl, username: 'u', password: 'p', database: 'd' })).toThrow(
      expect.objectContaining({ code }),
    );
  });

  test('requires username and password', () => {
    expect(() => mgr.validateAtlasInput({ connectionUrl: 'mongodb+srv://cluster0.x.mongodb.net/', database: 'd' })).toThrow(
      expect.objectContaining({ code: 'MISSING_CREDENTIALS' }),
    );
    expect(() => mgr.validateAtlasInput({ connectionUrl: 'mongodb+srv://bob@cluster0.x.mongodb.net/', database: 'd' })).toThrow(
      expect.objectContaining({ code: 'MISSING_CREDENTIALS' }),
    );
    expect(() =>
      mgr.validateAtlasInput({ connectionUrl: 'mongodb+srv://bob:<password>@cluster0.x.mongodb.net/', database: 'd' }),
    ).toThrow(expect.objectContaining({ code: 'MISSING_CREDENTIALS' }));
  });

  test('only allows Atlas hosts (prevents pointing the server at internal hosts)', () => {
    expect(() =>
      mgr.validateAtlasInput({ connectionUrl: 'mongodb://u:p@10.0.0.5:27017/x' }),
    ).toThrow(expect.objectContaining({ code: 'HOST_NOT_ALLOWED' }));
    expect(() =>
      mgr.validateAtlasInput({ connectionUrl: 'mongodb+srv://u:p@evil-mongodb.net.attacker.com/x' }),
    ).toThrow(expect.objectContaining({ code: 'HOST_NOT_ALLOWED' }));
  });

  test('requires a non-reserved database name', () => {
    for (const database of ['admin', 'local', 'config', 'bad name', '']) {
      expect(() =>
        mgr.validateAtlasInput({ connectionUrl: 'mongodb+srv://u:p@cluster0.x.mongodb.net/', database }),
      ).toThrow(expect.objectContaining({ code: 'INVALID_DATABASE' }));
    }
  });
});

describe('connection error classification', () => {
  const cases = [
    [Object.assign(new Error('bad auth : Authentication failed.'), { code: 8000 }), 'AUTH_FAILED'],
    [Object.assign(new Error('Authentication failed.'), { code: 18 }), 'AUTH_FAILED'],
    [new Error('querySrv ENOTFOUND _mongodb._tcp.nope.mongodb.net'), 'HOST_NOT_FOUND'],
    [new Error('getaddrinfo EAI_AGAIN cluster0.x.mongodb.net'), 'HOST_NOT_FOUND'],
    [Object.assign(new Error('Server selection timed out after 30000 ms'), { name: 'MongoServerSelectionError' }), 'TIMEOUT'],
    [new Error('connect ETIMEDOUT 10.255.255.1:27017'), 'TIMEOUT'],
    [
      new Error("Could not connect to any servers in your MongoDB Atlas cluster. One common reason is that you're trying to access the database from an IP that isn't whitelisted."),
      'NETWORK_ACCESS_DENIED',
    ],
    [new Error('connect ECONNREFUSED 127.0.0.1:27017'), 'DATABASE_UNAVAILABLE'],
    [Object.assign(new Error('Invalid scheme, expected connection string to start with "mongodb://"'), { name: 'MongoParseError' }), 'INVALID_URL'],
    [new Error('something odd'), 'CONNECTION_FAILED'],
  ];
  test.each(cases)('%s -> %s', (err, code) => {
    const c = classifyConnectionError(err);
    expect(c.code).toBe(code);
    expect(c.message).not.toMatch(/[\w-]+:[\w-]+@/); // never echoes credentials
  });
});

describe('testAtlasConnection (mocked driver)', () => {
  test('success reports present and missing practice collections', async () => {
    const { mgr, clientFactory } = makeManager({ collections: ['students', 'products', 'system.views'] });
    const r = await mgr.testAtlasConnection('mongodb+srv://u:p@c.mongodb.net/x', 'x', ['students', 'products', 'orders']);
    expect(r.presentCollections).toEqual(['students', 'products']);
    expect(r.missingCollections).toEqual(['orders']);
    expect(clientFactory.created[0].close).toHaveBeenCalled();
    await mgr.closeAll();
  });

  test('connection timeout', async () => {
    const err = Object.assign(new Error('Server selection timed out after 1000 ms'), { name: 'MongoServerSelectionError' });
    const { mgr, clientFactory } = makeManager({ connectError: err });
    await expect(mgr.testAtlasConnection('mongodb+srv://u:p@c.mongodb.net/x', 'x', [])).rejects.toMatchObject({ code: 'TIMEOUT', status: 504 });
    expect(clientFactory.created[0].close).toHaveBeenCalled();
    await mgr.closeAll();
  });

  test('network access denied (IP access list)', async () => {
    const err = new Error("Could not connect to any servers in your MongoDB Atlas cluster. One common reason is that you're trying to access the database from an IP that isn't whitelisted.");
    const { mgr } = makeManager({ connectError: err });
    await expect(mgr.testAtlasConnection('mongodb+srv://u:p@c.mongodb.net/x', 'x', [])).rejects.toMatchObject({ code: 'NETWORK_ACCESS_DENIED' });
    await mgr.closeAll();
  });

  test('rejects administrator-level users', async () => {
    const { mgr } = makeManager({ roles: [{ role: 'atlasAdmin', db: 'admin' }] });
    await expect(mgr.testAtlasConnection('mongodb+srv://u:p@c.mongodb.net/x', 'x', [])).rejects.toMatchObject({ code: 'ADMIN_CREDENTIALS_NOT_ALLOWED' });
    await mgr.closeAll();
  });

  test('warns for users with access to every database', async () => {
    const { mgr } = makeManager({ roles: [{ role: 'readWriteAnyDatabase', db: 'admin' }] });
    const r = await mgr.testAtlasConnection('mongodb+srv://u:p@c.mongodb.net/x', 'x', []);
    expect(r.warnings[0]).toMatch(/every database/);
    await mgr.closeAll();
  });
});

describe('connection pooling', () => {
  test('reuses a pooled client, replaces it when the URI changes and releases on disconnect', async () => {
    const { mgr, clientFactory } = makeManager();
    const enc1 = mgr.encryptUri('mongodb+srv://u:p@c.mongodb.net/a');
    const enc2 = mgr.encryptUri('mongodb+srv://u:p2@c.mongodb.net/a');
    await mgr.getAtlasDb('u1', { encryptedUri: enc1, database: 'a' });
    await mgr.getAtlasDb('u1', { encryptedUri: enc1, database: 'a' });
    expect(clientFactory.created).toHaveLength(1);
    await mgr.getAtlasDb('u1', { encryptedUri: enc2, database: 'a' });
    expect(clientFactory.created).toHaveLength(2);
    expect(clientFactory.created[0].closed).toBe(true);
    await mgr.disconnectUser('u1');
    expect(clientFactory.created[1].closed).toBe(true);
    expect(mgr.pool.size).toBe(0);
    await mgr.closeAll();
  });

  test('closes idle connections', async () => {
    const { mgr, clientFactory } = makeManager();
    await mgr.getAtlasDb('u2', { encryptedUri: mgr.encryptUri('mongodb+srv://u:p@c.mongodb.net/a'), database: 'a' });
    mgr.pool.get('atlas:u2').lastUsed = Date.now() - 5000;
    await mgr.sweepIdle();
    expect(clientFactory.created[0].closed).toBe(true);
    await mgr.closeAll();
  });

  test('public view never contains the connection string or credentials', () => {
    const view = ConnectionManager.publicView({
      mode: 'atlas', status: 'connected', host: 'cluster0.x.mongodb.net', database: 'p', usernameHint: 'st***',
      encryptedUri: 'v1:abc', uri: 'mongodb+srv://u:p@cluster0.x.mongodb.net/p',
    });
    expect(JSON.stringify(view)).not.toMatch(/mongodb\+srv|encrypted|v1:abc|u:p@/);
  });
});
