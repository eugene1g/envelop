import { readFile } from 'node:fs/promises';
import { GetStaticProps, GetStaticPaths } from 'next';
import { buildDynamicMDX, buildDynamicMeta } from 'nextra/remote';
import { findPathWithExtension, findStaticPaths } from '@/lib/remote-utils';
import { REPO, BRANCH, ROOT_DIR } from '@/lib/constants';

export const getStaticPaths: GetStaticPaths = async () => ({
  fallback: 'blocking',
  paths: await findStaticPaths({ repo: REPO, rootDir: ROOT_DIR, ref: BRANCH }),
});

export const getStaticProps: GetStaticProps = async ({ params }) => {
  const filePath = await findPathWithExtension({
    repo: REPO,
    rootDir: ROOT_DIR,
    slug: params!.slug as string[],
  });
  const content = await readFile(filePath, 'utf8');
  const mdx = await buildDynamicMDX(content, {
    defaultShowCopyCode: true,
    remarkLinkRewriteOptions: {
      pattern: /^\/docs(\/.*)?$/,
      replace: '/v2$1',
    },
  });

  return {
    props: {
      ...mdx,
      ...(await buildDynamicMeta()),
    },
    // Revalidate at most once every 1 week
    revalidate: 60 * 60 * 24 * 7,
  };
};
