import { ContextFactoryFn, useExtendContext } from '@envelop/core';
import { createSpiedPlugin, createTestkit } from '@envelop/testing';
import { schema, query } from './common.js';

describe('contextFactory', () => {
  it('Should call before parse and after parse correctly', async () => {
    const spiedPlugin = createSpiedPlugin();
    const teskit = createTestkit([spiedPlugin.plugin], schema);
    await teskit.execute(query);
    expect(spiedPlugin.spies.beforeContextBuilding).toHaveBeenCalledTimes(1);
    expect(spiedPlugin.spies.beforeContextBuilding).toHaveBeenCalledWith({
      context: expect.any(Object),
      extendContext: expect.any(Function),
      breakContextBuilding: expect.any(Function),
    });

    expect(spiedPlugin.spies.afterContextBuilding).toHaveBeenCalledTimes(1);
    expect(spiedPlugin.spies.afterContextBuilding).toHaveBeenCalledWith({
      context: expect.any(Object),
      extendContext: expect.any(Function),
    });
  });

  it('Should set initial `createProxy` arguments as initial context', async () => {
    const spiedPlugin = createSpiedPlugin();
    const teskit = createTestkit([spiedPlugin.plugin], schema);
    await teskit.execute(query, {}, { test: true });
    expect(spiedPlugin.spies.beforeContextBuilding).toHaveBeenCalledTimes(1);
    expect(spiedPlugin.spies.beforeContextBuilding).toHaveBeenCalledWith({
      context: expect.objectContaining({
        test: true,
      }),
      extendContext: expect.any(Function),
      breakContextBuilding: expect.any(Function),
    });
  });

  it('Should allow to extend context', async () => {
    const afterContextSpy = jest.fn();
    const onExecuteSpy = jest.fn();

    const teskit = createTestkit(
      [
        {
          onContextBuilding({ extendContext }) {
            extendContext({
              test: true,
            });

            return afterContextSpy;
          },
          onExecute: onExecuteSpy,
        },
      ],
      schema
    );

    await teskit.execute(query, {}, {});
    expect(afterContextSpy).toHaveBeenCalledWith({
      context: expect.objectContaining({
        test: true,
      }),
      extendContext: expect.any(Function),
    });

    expect(onExecuteSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        args: expect.objectContaining({
          contextValue: expect.objectContaining({
            test: true,
          }),
        }),
      })
    );
  });

  it('Should allow to provide async function for context extension', async () => {
    const afterContextSpy = jest.fn();
    const onExecuteSpy = jest.fn();
    const teskit = createTestkit(
      [
        {
          onContextBuilding: async ({ extendContext }) => {
            await new Promise(resolve => setTimeout(resolve, 1000));

            extendContext({
              test: true,
            });

            return afterContextSpy;
          },
          onExecute: onExecuteSpy,
        },
      ],
      schema
    );
    await teskit.execute(query, {}, {});
    expect(afterContextSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          test: true,
        }),
      })
    );
    expect(onExecuteSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        args: expect.objectContaining({
          contextValue: expect.objectContaining({
            test: true,
          }),
        }),
      })
    );
  });

  it('Should yield initial context to context error handlers', async () => {
    const registerContextErrorHandlerSpy = jest.fn();
    const contextFactory: ContextFactoryFn = () => {
      return {
        contextSoFar: 'all good',
      };
    };

    const throwingContextFactory: ContextFactoryFn = () => {
      throw new Error('The server was about to step on a turtle');
    };

    const teskit = createTestkit(
      [
        useExtendContext(contextFactory),
        useExtendContext(throwingContextFactory),
        {
          onPluginInit({ registerContextErrorHandler }) {
            registerContextErrorHandler(args => {
              registerContextErrorHandlerSpy(args);
            });
          },
        },
      ],
      schema
    );

    const execution = teskit.execute(query, {}, { test: true });
    return new Promise<void>((resolve, reject) => {
      if (execution instanceof Promise) {
        return execution.then().catch(() => {
          try {
            expect(registerContextErrorHandlerSpy).toHaveBeenCalledWith(
              expect.objectContaining({
                context: expect.objectContaining({
                  contextSoFar: 'all good',
                  document: expect.any(Object),
                  operation: expect.any(String),
                  request: expect.any(Object),
                  test: true,
                  variables: expect.any(Object),
                }),
                error: new Error('The server was about to step on a turtle'),
                setError: expect.any(Function),
              })
            );
          } catch (e) {
            reject(e);
          }
          return resolve();
        });
      } else {
        return reject('Expected result of testkit.execute to return a promise');
      }
    });
  });
});
