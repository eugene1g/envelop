import { getIntrospectionQuery, GraphQLObjectType, GraphQLSchema } from 'graphql';
import { assertSingleExecutionValue, createTestkit, TestkitInstance } from '@envelop/testing';
import { makeExecutableSchema } from '@graphql-tools/schema';
import { useValidationCache } from '@envelop/validation-cache';
import { useResponseCache, createInMemoryCache, defaultBuildResponseCacheKey } from '../src/index.js';
import { useParserCache } from '@envelop/parser-cache';
import { useLogger } from '@envelop/core';
import { useGraphQlJit } from '@envelop/graphql-jit';

describe('useResponseCache', () => {
  beforeEach(() => jest.useRealTimers());

  it('custom ttl per type is used instead of the global ttl - only enable caching for a specific type when the global ttl is 0', async () => {
    jest.useFakeTimers();
    const spy = jest.fn(() => [
      {
        id: 1,
        name: 'User 1',
        comments: [
          {
            id: 1,
            text: 'Comment 1 of User 1',
          },
        ],
      },
      {
        id: 2,
        name: 'User 2',
        comments: [
          {
            id: 2,
            text: 'Comment 2 of User 2',
          },
        ],
      },
    ]);

    const schema = makeExecutableSchema({
      typeDefs: /* GraphQL */ `
        type Query {
          users: [User!]!
        }

        type User {
          id: ID!
          name: String!
          comments: [Comment!]!
          recentComment: Comment
        }

        type Comment {
          id: ID!
          text: String!
        }
      `,
      resolvers: {
        Query: {
          users: spy,
        },
      },
    });

    const testInstance = createTestkit(
      [
        useResponseCache({
          session: () => null,
          ttl: 0,
          ttlPerType: {
            User: 200,
          },
        }),
      ],
      schema
    );

    const query = /* GraphQL */ `
      query test {
        users {
          id
          name
          comments {
            id
            text
          }
        }
      }
    `;

    await testInstance.execute(query);
    await testInstance.execute(query);
    expect(spy).toHaveBeenCalledTimes(1);
    await testInstance.execute(query);
    expect(spy).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(201);
    await testInstance.execute(query);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('reuses the cache if the same query operation is executed in sequence without a TTL', async () => {
    const spy = jest.fn(() => [
      {
        id: 1,
        name: 'User 1',
        comments: [
          {
            id: 1,
            text: 'Comment 1 of User 1',
          },
        ],
      },
    ]);
    const schema = makeExecutableSchema({
      typeDefs: /* GraphQL */ `
        type Query {
          users: [User!]!
        }

        type Mutation {
          updateUser(id: ID!): User!
        }

        type User {
          id: ID!
          name: String!
          comments: [Comment!]!
          recentComment: Comment
        }

        type Comment {
          id: ID!
          text: String!
        }
      `,
      resolvers: {
        Query: {
          users: spy,
        },
      },
    });

    const testInstance = createTestkit([useResponseCache({ session: () => null })], schema);

    const query = /* GraphQL */ `
      query test {
        users {
          id
          name
          comments {
            id
            text
          }
        }
      }
    `;
    await testInstance.execute(query);
    await testInstance.execute(query);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('purges the cached query operation execution result upon executing a mutation that invalidates resources', async () => {
    const spy = jest.fn(() => [
      {
        id: 1,
        name: 'User 1',
        comments: [
          {
            id: 1,
            text: 'Comment 1 of User 1',
          },
        ],
      },
      {
        id: 2,
        name: 'User 2',
        comments: [
          {
            id: 2,
            text: 'Comment 2 of User 2',
          },
        ],
      },
    ]);

    const schema = makeExecutableSchema({
      typeDefs: /* GraphQL */ `
        type Query {
          users: [User!]!
        }

        type Mutation {
          updateUser(id: ID!): User!
        }

        type User {
          id: ID!
          name: String!
          comments: [Comment!]!
          recentComment: Comment
        }

        type Comment {
          id: ID!
          text: String!
        }
      `,
      resolvers: {
        Query: {
          users: spy,
        },
        Mutation: {
          updateUser(_, { id }) {
            return {
              id,
            };
          },
        },
      },
    });

    const testInstance = createTestkit(
      [useResponseCache({ session: () => null, includeExtensionMetadata: true })],
      schema
    );

    const query = /* GraphQL */ `
      query test {
        users {
          id
          name
          comments {
            id
            text
          }
        }
      }
    `;

    let result = await testInstance.execute(query);
    assertSingleExecutionValue(result);
    expect(result.extensions?.responseCache).toEqual({ hit: false, didCache: true, ttl: Infinity });
    result = await testInstance.execute(query);
    assertSingleExecutionValue(result);
    expect(result.extensions?.responseCache).toEqual({ hit: true });
    expect(spy).toHaveBeenCalledTimes(1);

    result = await testInstance.execute(
      /* GraphQL */ `
        mutation it($id: ID!) {
          updateUser(id: $id) {
            id
          }
        }
      `,
      {
        id: 1,
      }
    );
    assertSingleExecutionValue(result);
    expect(result?.extensions?.responseCache).toEqual({ invalidatedEntities: [{ id: '1', typename: 'User' }] });

    result = await testInstance.execute(query);
    assertSingleExecutionValue(result);
    expect(result.extensions?.responseCache).toEqual({ hit: false, didCache: true, ttl: Infinity });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('purges the cached query operation execution result upon executing a mutation that invalidates resources & having useGraphQlJit plugin at the same time', async () => {
    const spy = jest.fn(() => [
      {
        id: 1,
        name: 'User 1',
        comments: [
          {
            id: 1,
            text: 'Comment 1 of User 1',
          },
        ],
      },
      {
        id: 2,
        name: 'User 2',
        comments: [
          {
            id: 2,
            text: 'Comment 2 of User 2',
          },
        ],
      },
    ]);

    const schema = makeExecutableSchema({
      typeDefs: /* GraphQL */ `
        type Query {
          users: [User!]!
        }

        type Mutation {
          updateUser(id: ID!): User!
        }

        type User {
          id: ID!
          name: String!
          comments: [Comment!]!
          recentComment: Comment
        }

        type Comment {
          id: ID!
          text: String!
        }
      `,
      resolvers: {
        Query: {
          users: spy,
        },
        Mutation: {
          updateUser(_, { id }) {
            return {
              id,
            };
          },
        },
      },
    });

    const testInstance = createTestkit(
      [
        useResponseCache({
          session: () => null,
          includeExtensionMetadata: true,
        }),
        useGraphQlJit(),
      ],
      schema
    );

    const query = /* GraphQL */ `
      query test {
        users {
          id
          name
          comments {
            id
            text
          }
        }
      }
    `;

    let result = await testInstance.execute(query);
    assertSingleExecutionValue(result);
    expect(result.extensions?.responseCache).toEqual({ hit: false, didCache: true, ttl: Infinity });
    result = await testInstance.execute(query);
    assertSingleExecutionValue(result);
    expect(result.extensions?.responseCache).toEqual({ hit: true });
    expect(spy).toHaveBeenCalledTimes(1);

    result = await testInstance.execute(
      /* GraphQL */ `
        mutation it($id: ID!) {
          updateUser(id: $id) {
            id
          }
        }
      `,
      {
        id: 1,
      }
    );
    assertSingleExecutionValue(result);
    expect(result?.extensions?.responseCache).toEqual({ invalidatedEntities: [{ id: '1', typename: 'User' }] });

    result = await testInstance.execute(query);
    assertSingleExecutionValue(result);
    expect(result.extensions?.responseCache).toEqual({ hit: false, didCache: true, ttl: Infinity });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('purges cached query operation execution result via imperative cache.invalidate api using typename and id', async () => {
    const spy = jest.fn(() => [
      {
        id: 1,
        name: 'User 1',
        comments: [
          {
            id: 1,
            text: 'Comment 1 of User 1',
          },
        ],
      },
      {
        id: 2,
        name: 'User 2',
        comments: [
          {
            id: 2,
            text: 'Comment 2 of User 2',
          },
        ],
      },
    ]);
    const schema = makeExecutableSchema({
      typeDefs: /* GraphQL */ `
        type Query {
          users: [User!]!
        }

        type Mutation {
          updateUser(id: ID!): User!
        }

        type User {
          id: ID!
          name: String!
          comments: [Comment!]!
          recentComment: Comment
        }

        type Comment {
          id: ID!
          text: String!
        }
      `,
      resolvers: {
        Query: {
          users: spy,
        },
        Mutation: {
          updateUser(_, { id }) {
            return {
              id,
            };
          },
        },
      },
    });

    const cache = createInMemoryCache();
    const testInstance = createTestkit([useResponseCache({ session: () => null, cache })], schema);

    const query = /* GraphQL */ `
      query test {
        users {
          id
          name
          comments {
            id
            text
          }
        }
      }
    `;

    await testInstance.execute(query);
    await testInstance.execute(query);
    expect(spy).toHaveBeenCalledTimes(1);

    cache.invalidate([{ typename: 'Comment', id: 2 }]);

    await testInstance.execute(query);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('purges cached query operation execution result via imperative cache.invalidate api using typename', async () => {
    const spy = jest.fn(() => [
      {
        id: 1,
        name: 'User 1',
        comments: [
          {
            id: 1,
            text: 'Comment 1 of User 1',
          },
        ],
      },
      {
        id: 2,
        name: 'User 2',
        comments: [
          {
            id: 2,
            text: 'Comment 2 of User 2',
          },
        ],
      },
    ]);
    const schema = makeExecutableSchema({
      typeDefs: /* GraphQL */ `
        type Query {
          users: [User!]!
        }

        type Mutation {
          updateUser(id: ID!): User!
        }

        type User {
          id: ID!
          name: String!
          comments: [Comment!]!
          recentComment: Comment
        }

        type Comment {
          id: ID!
          text: String!
        }
      `,
      resolvers: {
        Query: {
          users: spy,
        },
        Mutation: {
          updateUser(_, { id }) {
            return {
              id,
            };
          },
        },
      },
    });

    const cache = createInMemoryCache();
    const testInstance = createTestkit([useResponseCache({ session: () => null, cache })], schema);

    const query = /* GraphQL */ `
      query test {
        users {
          id
          name
          comments {
            id
            text
          }
        }
      }
    `;

    await testInstance.execute(query);
    await testInstance.execute(query);
    expect(spy).toHaveBeenCalledTimes(1);

    cache.invalidate([{ typename: 'Comment' }]);

    await testInstance.execute(query);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('variables are used for constructing the cache key', async () => {
    const spy = jest.fn((_, { limit }: { limit: number }) =>
      [
        {
          id: 1,
          name: 'User 1',
          comments: [
            {
              id: 1,
              text: 'Comment 1 of User 1',
            },
          ],
        },
        {
          id: 2,
          name: 'User 2',
          comments: [
            {
              id: 2,
              text: 'Comment 2 of User 2',
            },
          ],
        },
      ].slice(0, limit)
    );

    const schema = makeExecutableSchema({
      typeDefs: /* GraphQL */ `
        type Query {
          users(limit: Int!): [User!]!
        }

        type User {
          id: ID!
          name: String!
          comments: [Comment!]!
          recentComment: Comment
        }

        type Comment {
          id: ID!
          text: String!
        }
      `,
      resolvers: {
        Query: {
          users: spy,
        },
      },
    });

    const testInstance = createTestkit([useResponseCache({ session: () => null })], schema);

    const query = /* GraphQL */ `
      query it($limit: Int!) {
        users(limit: $limit) {
          id
          name
          comments {
            id
            text
          }
        }
      }
    `;

    await testInstance.execute(query, { limit: 2 });
    await testInstance.execute(query, { limit: 2 });
    expect(spy).toHaveBeenCalledTimes(1);
    await testInstance.execute(query, { limit: 1 });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('cached query execution results are purged after the ttl expires', async () => {
    jest.useFakeTimers();

    const spy = jest.fn(() => [
      {
        id: 1,
        name: 'User 1',
        comments: [
          {
            id: 1,
            text: 'Comment 1 of User 1',
          },
        ],
      },
      {
        id: 2,
        name: 'User 2',
        comments: [
          {
            id: 2,
            text: 'Comment 2 of User 2',
          },
        ],
      },
    ]);

    const schema = makeExecutableSchema({
      typeDefs: /* GraphQL */ `
        type Query {
          users: [User!]!
        }

        type User {
          id: ID!
          name: String!
          comments: [Comment!]!
          recentComment: Comment
        }

        type Comment {
          id: ID!
          text: String!
        }
      `,
      resolvers: {
        Query: {
          users: spy,
        },
      },
    });

    const testInstance = createTestkit([useResponseCache({ session: () => null, ttl: 100 })], schema);

    const query = /* GraphQL */ `
      query test {
        users {
          id
          name
          comments {
            id
            text
          }
        }
      }
    `;

    await testInstance.execute(query);
    await testInstance.execute(query);
    expect(spy).toHaveBeenCalledTimes(1);

    // let's travel in time beyond the ttl of 100
    jest.advanceTimersByTime(150);

    await testInstance.execute(query);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('query execution results can be cached based on a session with the session parameter', async () => {
    const spy = jest.fn(() => [
      {
        id: 1,
        name: 'User 1',
        comments: [
          {
            id: 1,
            text: 'Comment 1 of User 1',
          },
        ],
      },
      {
        id: 2,
        name: 'User 2',
        comments: [
          {
            id: 2,
            text: 'Comment 2 of User 2',
          },
        ],
      },
    ]);

    const schema = makeExecutableSchema({
      typeDefs: /* GraphQL */ `
        type Query {
          users: [User!]!
        }

        type User {
          id: ID!
          name: String!
          comments: [Comment!]!
          recentComment: Comment
        }

        type Comment {
          id: ID!
          text: String!
        }
      `,
      resolvers: {
        Query: {
          users: spy,
        },
      },
    });

    const testInstance = createTestkit(
      [
        useResponseCache({
          session(ctx: { sessionId: number }) {
            return ctx.sessionId + '';
          },
        }),
      ],
      schema
    );

    const query = /* GraphQL */ `
      query test {
        users {
          id
          name
          comments {
            id
            text
          }
        }
      }
    `;

    await testInstance.execute(
      query,
      {},
      {
        sessionId: 1,
      }
    );
    await testInstance.execute(
      query,
      {},
      {
        sessionId: 1,
      }
    );
    expect(spy).toHaveBeenCalledTimes(1);
    await testInstance.execute(
      query,
      {},
      {
        sessionId: 2,
      }
    );
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('query operations including ignored types are never cached', async () => {
    const spy = jest.fn(() => [
      {
        id: 1,
        name: 'User 1',
        comments: [
          {
            id: 1,
            text: 'Comment 1 of User 1',
          },
        ],
      },
      {
        id: 2,
        name: 'User 2',
        comments: [
          {
            id: 2,
            text: 'Comment 2 of User 2',
          },
        ],
      },
    ]);

    const schema = makeExecutableSchema({
      typeDefs: /* GraphQL */ `
        type Query {
          users: [User!]!
        }

        type User {
          id: ID!
          name: String!
          comments: [Comment!]!
          recentComment: Comment
        }

        type Comment {
          id: ID!
          text: String!
        }
      `,
      resolvers: {
        Query: {
          users: spy,
        },
      },
    });

    const testInstance = createTestkit([useResponseCache({ session: () => null, ignoredTypes: ['Comment'] })], schema);

    const query = /* GraphQL */ `
      query test {
        users {
          id
          name
          comments {
            id
            text
          }
        }
      }
    `;

    await testInstance.execute(query);
    await testInstance.execute(query);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('custom ttl can be specified per object type and will be used over the default ttl for caching a query operation execution result if included in the operation document', async () => {
    jest.useFakeTimers();
    const spy = jest.fn(() => [
      {
        id: 1,
        name: 'User 1',
        comments: [
          {
            id: 1,
            text: 'Comment 1 of User 1',
          },
        ],
      },
      {
        id: 2,
        name: 'User 2',
        comments: [
          {
            id: 2,
            text: 'Comment 2 of User 2',
          },
        ],
      },
    ]);

    const schema = makeExecutableSchema({
      typeDefs: /* GraphQL */ `
        type Query {
          users: [User!]!
        }

        type User {
          id: ID!
          name: String!
          comments: [Comment!]!
          recentComment: Comment
        }

        type Comment {
          id: ID!
          text: String!
        }
      `,
      resolvers: {
        Query: {
          users: spy,
        },
      },
    });

    const testInstance = createTestkit(
      [
        useResponseCache({
          session: () => null,
          ttl: 500,
          ttlPerType: {
            User: 200,
          },
        }),
      ],
      schema
    );

    const query = /* GraphQL */ `
      query test {
        users {
          id
          name
          comments {
            id
            text
          }
        }
      }
    `;

    await testInstance.execute(query);
    await testInstance.execute(query);
    expect(spy).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(201);
    await testInstance.execute(query);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('custom ttl can be specified per schema coordinate and will be used over the default ttl for caching a query operation execution result if included in the operation document', async () => {
    jest.useFakeTimers();
    const spy = jest.fn(() => [
      {
        id: 1,
        name: 'User 1',
        comments: [
          {
            id: 1,
            text: 'Comment 1 of User 1',
          },
        ],
      },
      {
        id: 2,
        name: 'User 2',
        comments: [
          {
            id: 2,
            text: 'Comment 2 of User 2',
          },
        ],
      },
    ]);

    const schema = makeExecutableSchema({
      typeDefs: /* GraphQL */ `
        type Query {
          users: [User!]!
        }

        type User {
          id: ID!
          name: String!
          comments: [Comment!]!
          recentComment: Comment
        }

        type Comment {
          id: ID!
          text: String!
        }
      `,
      resolvers: {
        Query: {
          users: spy,
        },
      },
    });

    const testInstance = createTestkit(
      [
        useResponseCache({
          session: () => null,
          ttl: 500,
          ttlPerSchemaCoordinate: {
            'Query.users': 200,
          },
        }),
      ],
      schema
    );

    const query = /* GraphQL */ `
      query test {
        users {
          id
          name
          comments {
            id
            text
          }
        }
      }
    `;

    await testInstance.execute(query);
    await testInstance.execute(query);
    expect(spy).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(201);
    await testInstance.execute(query);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('global ttl is disabled when providing value 0, which results in query operation execution results to be never cached', async () => {
    const spy = jest.fn(() => [
      {
        id: 1,
        name: 'User 1',
        comments: [
          {
            id: 1,
            text: 'Comment 1 of User 1',
          },
        ],
      },
      {
        id: 2,
        name: 'User 2',
        comments: [
          {
            id: 2,
            text: 'Comment 2 of User 2',
          },
        ],
      },
    ]);

    const schema = makeExecutableSchema({
      typeDefs: /* GraphQL */ `
        type Query {
          users: [User!]!
        }

        type User {
          id: ID!
          name: String!
          comments: [Comment!]!
          recentComment: Comment
        }

        type Comment {
          id: ID!
          text: String!
        }
      `,
      resolvers: {
        Query: {
          users: spy,
        },
      },
    });

    const testInstance = createTestkit([useResponseCache({ session: () => null, ttl: 0 })], schema);

    const query = /* GraphQL */ `
      query test {
        users {
          id
          name
          comments {
            id
            text
          }
        }
      }
    `;

    await testInstance.execute(query);
    await testInstance.execute(query);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('schema coordinate ttl is prioritized over global ttl', async () => {
    jest.useFakeTimers();
    const userSpy = jest.fn(() => [
      {
        id: 1,
        name: 'User 1',
        comments: [
          {
            id: 1,
            text: 'Comment 1 of User 1',
          },
        ],
      },
      {
        id: 2,
        name: 'User 2',
        comments: [
          {
            id: 2,
            text: 'Comment 2 of User 2',
          },
        ],
      },
    ]);

    const orderSpy = jest.fn(() => [
      {
        id: 1,
        products: [
          {
            id: 1,
            name: 'Jeans',
          },
        ],
      },
      {
        id: 2,
        products: [
          {
            id: 2,
            name: 'Shoes',
          },
        ],
      },
    ]);

    const schema = makeExecutableSchema({
      typeDefs: /* GraphQL */ `
        type Query {
          users: [User!]!
          orders: [Order!]!
        }

        type User {
          id: ID!
          name: String!
          comments: [Comment!]!
          recentComment: Comment
        }

        type Comment {
          id: ID!
          text: String!
        }

        type Order {
          id: ID!
          products: [Product!]!
        }

        type Product {
          id: ID!
          name: String!
        }
      `,
      resolvers: {
        Query: {
          users: userSpy,
          orders: orderSpy,
        },
      },
    });

    const testInstance = createTestkit(
      [
        useResponseCache({
          session: () => null,
          ttl: 1,
          ttlPerSchemaCoordinate: {
            'Query.users': 200,
          },
          includeExtensionMetadata: true,
        }),
      ],
      schema
    );

    const userQuery = /* GraphQL */ `
      query test {
        users {
          id
          name
          comments {
            id
            text
          }
        }
      }
    `;

    const orderQuery = /* GraphQL */ `
      query test {
        orders {
          id
          products {
            id
            name
          }
        }
      }
    `;

    let result = await testInstance.execute(userQuery);
    assertSingleExecutionValue(result);
    expect(result.extensions).toEqual({
      responseCache: {
        didCache: true,
        hit: false,
        ttl: 200,
      },
    });
    result = await testInstance.execute(orderQuery);
    assertSingleExecutionValue(result);
    expect(result.extensions).toEqual({
      responseCache: {
        didCache: true,
        hit: false,
        ttl: 1,
      },
    });

    jest.advanceTimersByTime(2);
    await testInstance.execute(userQuery);
    await testInstance.execute(orderQuery);
    expect(userSpy).toHaveBeenCalledTimes(1);
    expect(orderSpy).toHaveBeenCalledTimes(2);
    jest.advanceTimersByTime(201);
    await testInstance.execute(userQuery);
    expect(userSpy).toHaveBeenCalledTimes(2);
  });

  it('ttl=0 and ttlPerType should cache correctly', async () => {
    jest.useFakeTimers();
    const userSpy = jest.fn(() => [
      {
        id: 1,
        name: 'User 1',
        comments: [
          {
            id: 1,
            text: 'Comment 1 of User 1',
          },
        ],
      },
      {
        id: 2,
        name: 'User 2',
        comments: [
          {
            id: 2,
            text: 'Comment 2 of User 2',
          },
        ],
      },
    ]);

    const schema = makeExecutableSchema({
      typeDefs: /* GraphQL */ `
        type Query {
          users: [User!]!
        }

        type User {
          id: ID!
          name: String!
          comments: [Comment!]!
          recentComment: Comment
        }

        type Comment {
          id: ID!
          text: String!
        }
      `,
      resolvers: {
        Query: {
          users: userSpy,
        },
      },
    });

    const testInstance = createTestkit(
      [
        useResponseCache({
          session: () => null,
          ttl: 0,
          ttlPerType: {
            User: 200,
          },
          includeExtensionMetadata: true,
        }),
      ],
      schema
    );

    const userQuery = /* GraphQL */ `
      query test {
        users {
          id
          name
          comments {
            id
            text
          }
        }
      }
    `;

    let result = await testInstance.execute(userQuery);
    assertSingleExecutionValue(result);
    expect(result.extensions).toEqual({
      responseCache: {
        didCache: true,
        hit: false,
        ttl: 200,
      },
    });

    jest.advanceTimersByTime(2);
    result = await testInstance.execute(userQuery);
    assertSingleExecutionValue(result);
    expect(result.extensions).toEqual({
      responseCache: {
        hit: true,
      },
    });

    jest.advanceTimersByTime(200);

    result = await testInstance.execute(userQuery);
    assertSingleExecutionValue(result);
    expect(result.extensions).toEqual({
      responseCache: {
        didCache: true,
        hit: false,
        ttl: 200,
      },
    });
  });

  it('execution results with errors are never cached by default', async () => {
    const spy = jest.fn(() => {
      throw new Error('Do not cache an error');
    });

    const schema = makeExecutableSchema({
      typeDefs: /* GraphQL */ `
        type Query {
          users: [User!]!
        }

        type User {
          id: ID!
          name: String!
        }
      `,
      resolvers: {
        Query: {
          users: spy,
        },
      },
    });

    const testInstance = createTestkit([useResponseCache({ session: () => null })], schema);

    const query = /* GraphQL */ `
      query test {
        users {
          id
          name
        }
      }
    `;
    await testInstance.execute(query);
    await testInstance.execute(query);
    await testInstance.execute(query);
    await testInstance.execute(query);
    expect(spy).toHaveBeenCalledTimes(4);
  });

  it('custom shouldCache parameter can override the default behavior and cache execution results with errors', async () => {
    const spy = jest.fn(() => {
      throw new Error('Do not cache an error');
    });

    const schema = makeExecutableSchema({
      typeDefs: /* GraphQL */ `
        type Query {
          users: [User!]!
        }

        type User {
          id: ID!
          name: String!
        }
      `,
      resolvers: {
        Query: {
          users: spy,
        },
      },
    });

    const testInstance = createTestkit(
      [
        useResponseCache({
          session: () => null,
          // cache any query execution result
          shouldCacheResult: () => true,
        }),
      ],
      schema
    );

    const query = /* GraphQL */ `
      query test {
        users {
          id
          name
        }
      }
    `;
    await testInstance.execute(query);
    await testInstance.execute(query);
    await testInstance.execute(query);
    await testInstance.execute(query);
    // the resolver is only called once as all following executions hit the cache
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it.skip('cache is purged upon mutation even when error is included in the mutation execution result', async () => {
    3;
    const spy = jest.fn(() => [
      {
        id: 1,
        name: 'User 1',
        comments: [
          {
            id: 1,
            text: 'Comment 1 of User 1',
          },
        ],
      },
      {
        id: 2,
        name: 'User 2',
        comments: [
          {
            id: 2,
            text: 'Comment 2 of User 2',
          },
        ],
      },
    ]);

    const errorSpy = jest.fn(() => {
      throw new Error('could not get name');
    });

    const schema = makeExecutableSchema({
      typeDefs: /* GraphQL */ `
        type Query {
          users: [User!]!
        }

        type Mutation {
          updateUser(id: ID!): User!
        }

        type User {
          id: ID!
          name: String!
          comments: [Comment!]!
          recentComment: Comment
        }

        type Comment {
          id: ID!
          text: String!
        }
      `,
      resolvers: {
        Query: {
          users: spy,
        },
        Mutation: {
          updateUser(_, { id }) {
            return {
              id,
              name: errorSpy,
            };
          },
        },
      },
    });

    const testInstance = createTestkit(
      [useResponseCache({ session: () => null, includeExtensionMetadata: true })],
      schema
    );

    const query = /* GraphQL */ `
      query test {
        users {
          id
          name
          comments {
            id
            text
          }
        }
      }
    `;

    await testInstance.execute(query);
    await testInstance.execute(query);
    expect(spy).toHaveBeenCalledTimes(1);

    await testInstance.execute(
      /* GraphQL */ `
        mutation it($id: ID!) {
          updateUser(id: $id) {
            id
            name
          }
        }
      `,
      {
        id: 1,
      }
    );

    expect(errorSpy).toHaveBeenCalledTimes(1);

    await testInstance.execute(query);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('introspection query operation is not cached with default options', async () => {
    const introspectionQuery = getIntrospectionQuery();

    const schema = makeExecutableSchema({
      typeDefs: /* GraphQL */ `
        type Query {
          user: User!
        }
        type User {
          id: ID!
          name: String!
        }
      `,
      resolvers: {
        Query: {
          user: {
            id: 1,
            name: 'User 1',
          },
        },
      },
    });

    // keeps track how often the '__Schema.queryType' resolver has been called
    // aka a introspection query operation has been executed
    // we wrap that field and increment the counter
    let introspectionCounter = 0;

    const schemaType = schema.getType('__Schema') as GraphQLObjectType;
    const schemaTypeQueryTypeField = schemaType.getFields()['queryType'];
    const originalResolve = schemaTypeQueryTypeField.resolve!;
    schemaTypeQueryTypeField.resolve = (...args) => {
      introspectionCounter++;
      return originalResolve(...args);
    };

    const cache = createInMemoryCache();
    const testInstance = createTestkit([useResponseCache({ session: () => null, cache })], schema);

    // after each execution the introspectionCounter should be incremented by 1
    // as we never cache the introspection

    await testInstance.execute(introspectionQuery);
    expect(introspectionCounter).toEqual(1);

    await testInstance.execute(introspectionQuery);
    expect(introspectionCounter).toEqual(2);
  });

  it("introspection query operation can be cached via 'ttlPerSchemaCoordinate' option", async () => {
    const introspectionQuery = getIntrospectionQuery();

    const schema = makeExecutableSchema({
      typeDefs: /* GraphQL */ `
        type Query {
          user: User!
        }
        type User {
          id: ID!
          name: String!
        }
      `,
      resolvers: {
        Query: {
          user: {
            id: 1,
            name: 'User 1',
          },
        },
      },
    });

    // keeps track how often the '__Schema.queryType' resolver has been called
    // aka a introspection query operation has been executed
    // we wrap that field and increment the counter
    let introspectionCounter = 0;

    const schemaType = schema.getType('__Schema') as GraphQLObjectType;
    const schemaTypeQueryTypeField = schemaType.getFields()['queryType'];
    const originalResolve = schemaTypeQueryTypeField.resolve!;
    schemaTypeQueryTypeField.resolve = (...args) => {
      introspectionCounter++;
      return originalResolve(...args);
    };

    const cache = createInMemoryCache();
    const testInstance = createTestkit(
      [useResponseCache({ session: () => null, cache, ttlPerSchemaCoordinate: { 'Query.__schema': undefined } })],
      schema
    );

    await testInstance.execute(introspectionQuery);
    // after the first execution the introspectionCounter should be incremented by 1
    expect(introspectionCounter).toEqual(1);

    await testInstance.execute(introspectionQuery);
    // as we now cache the introspection the resolver shall not be called for further introspections
    expect(introspectionCounter).toEqual(1);
  });

  it('query operation is not cached if an error occurs within a resolver', async () => {
    let usersResolverInvocationCount = 0;

    const schema = makeExecutableSchema({
      typeDefs: /* GraphQL */ `
        type User {
          id: ID!
          name: String!
        }

        type Query {
          users: [User!]!
        }
      `,
      resolvers: {
        Query: {
          users: () => {
            usersResolverInvocationCount++;
            return null;
          },
        },
      },
    });

    const cache = createInMemoryCache();
    const testInstance = createTestkit([useResponseCache({ session: () => null, cache })], schema);

    const query = /* GraphQL */ `
      query test {
        users {
          id
          name
        }
      }
    `;

    await testInstance.execute(query);
    expect(usersResolverInvocationCount).toEqual(1);

    const testInstance2 = createTestkit([useResponseCache({ session: () => null, cache })], schema);
    await testInstance2.execute(query);
    expect(usersResolverInvocationCount).toEqual(2);
  });

  it('response cache works with validation cache and parser cache', async () => {
    jest.useFakeTimers();
    const mockFn = jest.fn();
    const schema = makeExecutableSchema({
      typeDefs: /* GraphQL */ `
        type Query {
          foo: String
        }
      `,
      resolvers: { Query: { foo: () => void mockFn() || 'hi' } },
    });
    const testkit = createTestkit(
      [useValidationCache(), useResponseCache({ session: () => null }), useParserCache()],
      schema
    );

    const document = /* GraphQL */ `
      query {
        foo
      }
    `;

    let result = await testkit.execute(document);
    expect(result).toMatchInlineSnapshot(`
      Object {
        "data": Object {
          "foo": "hi",
        },
      }
    `);
    result = await testkit.execute(document);
    expect(result).toMatchInlineSnapshot(`
      Object {
        "data": Object {
          "foo": "hi",
        },
      }
    `);
    expect(mockFn).toHaveBeenCalledTimes(1);
  });

  it('does not stop other plugins from hooking into "onExecute" and "onExecuteDone"', async () => {
    const schema = makeExecutableSchema({
      typeDefs: /* GraphQL */ `
        type Query {
          foo: String
        }
      `,
      resolvers: { Query: { foo: () => 'hi' } },
    });
    const logs: Array<unknown> = [];
    const testkit = createTestkit(
      [
        useLogger({
          logFn: eventName => void logs.push(eventName),
        }),
        useResponseCache({ session: () => null, ttlPerSchemaCoordinate: { 'Query.foo': Infinity } }),
      ],
      schema
    );
    const operation = /* GraphQL */ `
      {
        foo
      }
    `;
    const result1 = await testkit.execute(operation);
    assertSingleExecutionValue(result1);
    const result2 = await testkit.execute(operation);
    assertSingleExecutionValue(result2);
    // ensure the response is served from the cache
    expect(result1).toBe(result2);
    // we had two invocations.
    expect(logs).toEqual(['execute-start', 'execute-end', 'execute-start', 'execute-end']);
  });

  describe('__typename related concerns', () => {
    it('keeps __typename in result if selected via selection set', async () => {
      const schema = makeExecutableSchema({
        typeDefs: /* GraphQL */ `
          type Query {
            user: User
          }

          type User {
            id: ID!
            friends: [User!]!
          }
        `,
        resolvers: {
          Query: {
            user: () => ({ id: 1, friends: [{ id: 2 }, { id: 3 }] }),
          },
        },
      });
      const testkit = createTestkit([useResponseCache({ session: () => null })], schema);
      const result = await testkit.execute(/* GraphQL */ `
        query {
          user {
            __typename
            id
            friends {
              __typename
              id
            }
          }
        }
      `);
      assertSingleExecutionValue(result);
      expect(result).toEqual({
        data: {
          user: {
            __typename: 'User',
            id: '1',
            friends: [
              { __typename: 'User', id: '2' },
              { __typename: 'User', id: '3' },
            ],
          },
        },
      });
    });

    it('does not include __typename in result if mot selected via selection set', async () => {
      const schema = makeExecutableSchema({
        typeDefs: /* GraphQL */ `
          type Query {
            user: User
          }

          type User {
            id: ID!
            friends: [User!]!
          }
        `,
        resolvers: {
          Query: {
            user: () => ({ id: 1, friends: [{ id: 2 }, { id: 3 }] }),
          },
        },
      });
      const testkit = createTestkit([useResponseCache({ session: () => null })], schema);
      const result = await testkit.execute(/* GraphQL */ `
        query {
          user {
            id
            friends {
              id
            }
          }
        }
      `);
      assertSingleExecutionValue(result);
      expect(result).toEqual({
        data: {
          user: {
            id: '1',
            friends: [{ id: '2' }, { id: '3' }],
          },
        },
      });
    });

    it('works properly if __typename within selection set is aliased', async () => {
      const schema = makeExecutableSchema({
        typeDefs: /* GraphQL */ `
          type Query {
            user: User
          }

          type User {
            id: ID!
            friends: [User!]!
          }
        `,
        resolvers: {
          Query: {
            user: () => ({ id: 1, friends: [{ id: 2 }, { id: 3 }] }),
          },
        },
      });
      const testkit = createTestkit([useResponseCache({ session: () => null })], schema);
      const result = await testkit.execute(/* GraphQL */ `
        query {
          user {
            foo: __typename
            id
            friends {
              id
            }
          }
        }
      `);
      assertSingleExecutionValue(result);
      expect(result).toEqual({
        data: {
          user: {
            foo: 'User',
            id: '1',
            friends: [{ id: '2' }, { id: '3' }],
          },
        },
      });
    });

    it('cache-hits for union fields', async () => {
      const schema = makeExecutableSchema({
        typeDefs: /* GraphQL */ `
          type Query {
            whatever: Whatever
          }

          interface Node {
            id: ID!
          }

          type Cat implements Node {
            id: ID!
          }

          type User implements Node {
            id: ID!
          }

          union Whatever = Cat | User
        `,
        resolvers: {
          Query: {
            whatever: () => ({ __typename: 'Cat', id: '1' }),
          },
        },
      });
      const operation = /* GraphQL */ `
        query {
          whatever {
            ... on Node {
              id
            }
          }
        }
      `;

      const cache = createInMemoryCache();
      const testkit = createTestkit(
        [useResponseCache({ session: () => null, includeExtensionMetadata: true, cache })],
        schema
      );

      let result = await testkit.execute(operation);
      assertSingleExecutionValue(result);
      expect(result).toEqual({
        data: {
          whatever: {
            id: '1',
          },
        },
        extensions: {
          responseCache: {
            didCache: true,
            hit: false,
            ttl: Infinity,
          },
        },
      });
      result = await testkit.execute(operation);
      assertSingleExecutionValue(result);
      expect(result.extensions?.['responseCache']).toEqual({
        hit: true,
      });
      await cache.invalidate([{ typename: 'Cat', id: '1' }]);
      result = await testkit.execute(operation);
      assertSingleExecutionValue(result);
      expect(result.extensions?.['responseCache']).toEqual({
        didCache: true,
        hit: false,
        ttl: Infinity,
      });
    });
  });

  describe('ignoring and ttl per type for types without id field', () => {
    let spyWithId: jest.Mock<{ id: Number; field: String }, []>;
    let spyWithoutId: jest.Mock<{ field: String }, []>;
    let schema: GraphQLSchema;

    beforeEach(() => {
      spyWithId = jest.fn(() => ({
        field: 'Hello World!',
        id: 1,
      }));

      spyWithoutId = jest.fn(() => ({
        field: 'Hello World!',
      }));

      schema = makeExecutableSchema({
        typeDefs: /* GraphQL */ `
          type TypeWithId {
            id: Int!
            field: String!
          }
          type TypeWithoutId {
            field: String!
          }

          type Query {
            withId: TypeWithId!
            withoutId: TypeWithoutId!
          }
        `,
        resolvers: {
          Query: {
            withId: spyWithId,
            withoutId: spyWithoutId,
          },
        },
      });
    });

    describe('ignoredTypes', () => {
      let testInstance: TestkitInstance;

      beforeEach(() => {
        testInstance = createTestkit(
          [
            useResponseCache({
              session: () => null,
              ttl: 500,
              ignoredTypes: ['TypeWithId', 'TypeWithoutId'],
            }),
          ],
          schema
        );
      });

      it('types with id field can be ignored when id is queried', async () => {
        const query = /* GraphQL */ `
          query test {
            withId {
              field
              id
            }
          }
        `;

        await testInstance.execute(query);
        await testInstance.execute(query);
        expect(spyWithId).toHaveBeenCalledTimes(2);
      });

      it('types with id field can be ignored when id is not queried', async () => {
        const query = /* GraphQL */ `
          query test {
            withId {
              field
            }
          }
        `;

        await testInstance.execute(query);
        await testInstance.execute(query);
        expect(spyWithId).toHaveBeenCalledTimes(2);
      });

      it('types without id field can be ignored', async () => {
        const query = /* GraphQL */ `
          query test {
            withoutId {
              field
            }
          }
        `;

        await testInstance.execute(query);
        await testInstance.execute(query);
        expect(spyWithoutId).toHaveBeenCalledTimes(2);
      });
    });

    describe('ttlPerType', () => {
      let testInstance: TestkitInstance;

      beforeEach(() => {
        testInstance = createTestkit(
          [
            useResponseCache({
              session: () => null,
              ttl: 0,
              ttlPerType: {
                TypeWithId: 500,
                TypeWithoutId: 500,
              },
            }),
          ],
          schema
        );
      });

      it('ttl can be set for types with id field when id is queried', async () => {
        const query = /* GraphQL */ `
          query test {
            withId {
              field
              id
            }
          }
        `;

        await testInstance.execute(query);
        await testInstance.execute(query);
        expect(spyWithId).toHaveBeenCalledTimes(1);
      });

      it('ttl can be set for types with id field when id is not queried', async () => {
        const query = /* GraphQL */ `
          query test {
            withId {
              field
            }
          }
        `;

        await testInstance.execute(query);
        await testInstance.execute(query);
        expect(spyWithId).toHaveBeenCalledTimes(1);
      });

      it('ttl can be set for types without id', async () => {
        const query = /* GraphQL */ `
          query test {
            withoutId {
              field
            }
          }
        `;

        await testInstance.execute(query);
        await testInstance.execute(query);
        expect(spyWithoutId).toHaveBeenCalledTimes(1);
      });
    });
  });

  it('keeps the existing extensions', async () => {
    const schema = makeExecutableSchema({
      typeDefs: /* GraphQL */ `
        type Query {
          foo: String
        }
      `,
      resolvers: {
        Query: {
          foo: () => 'bar',
        },
      },
    });
    const operation = /* GraphQL */ `
      query {
        foo
      }
    `;

    const cache = createInMemoryCache();
    const testkit = createTestkit(
      [
        {
          onExecute({ setExecuteFn }) {
            setExecuteFn(() => ({
              data: {
                foo: 'bar',
              },
              extensions: {
                myExtension: 'myExtensionValue',
              },
            }));
          },
        },
        useResponseCache({ session: () => null, includeExtensionMetadata: true, cache }),
      ],
      schema
    );

    const result = await testkit.execute(operation);
    assertSingleExecutionValue(result);
    expect(result).toEqual({
      data: {
        foo: 'bar',
      },
      extensions: {
        myExtension: 'myExtensionValue',
        responseCache: {
          didCache: true,
          hit: false,
          ttl: Infinity,
        },
      },
    });
  });
  it('keeps the existing response cache extensions', async () => {
    const schema = makeExecutableSchema({
      typeDefs: /* GraphQL */ `
        type Query {
          foo: String
        }
      `,
      resolvers: {
        Query: {
          foo: () => 'bar',
        },
      },
    });
    const operation = /* GraphQL */ `
      query {
        foo
      }
    `;

    const cache = createInMemoryCache();
    const testkit = createTestkit(
      [
        {
          onExecute({ setExecuteFn }) {
            setExecuteFn(() => ({
              data: {
                foo: 'bar',
              },
              extensions: {
                responseCache: {
                  myExtension: 'myExtensionValue',
                },
              },
            }));
          },
        },
        useResponseCache({ session: () => null, includeExtensionMetadata: true, cache }),
      ],
      schema
    );

    const result = await testkit.execute(operation);
    assertSingleExecutionValue(result);
    expect(result).toEqual({
      data: {
        foo: 'bar',
      },
      extensions: {
        responseCache: {
          myExtension: 'myExtensionValue',
          didCache: true,
          hit: false,
          ttl: Infinity,
        },
      },
    });
  });
  it('calls shouldCacheResult with correct parameters', async () => {
    const schema = makeExecutableSchema({
      typeDefs: /* GraphQL */ `
        type Query {
          foo: String
        }
      `,
      resolvers: {
        Query: {
          foo: () => 'bar',
        },
      },
    });
    const operation = /* GraphQL */ `
      query {
        foo
      }
    `;

    const shouldCacheResult = jest.fn(() => true);
    const cache = createInMemoryCache();
    const testkit = createTestkit(
      [
        useResponseCache({
          session: () => null,
          cache,
          shouldCacheResult,
        }),
      ],
      schema
    );

    const result = await testkit.execute(operation);
    assertSingleExecutionValue(result);
    const cacheKey = await defaultBuildResponseCacheKey({
      documentString: operation,
      variableValues: {},
      sessionId: null,
    });
    expect(shouldCacheResult).toHaveBeenCalledWith({
      cacheKey,
      result,
    });
  });
});
