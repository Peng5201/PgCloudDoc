import type { Config } from 'jest';
import { pathsToModuleNameMapper } from 'ts-jest';
import ts from 'typescript';

// Path aliases (e.g. the ones added by `nest g library`) live in tsconfig.json,
// so they are read from there instead of being duplicated here.
const { config: tsconfig } = ts.readConfigFile(
  './tsconfig.json',
  ts.sys.readFile,
);
const paths = tsconfig?.compilerOptions?.paths ?? {};

const config: Config = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  // 单元测试；e2e 走 test/jest-e2e.json（要 docker-compose 里的服务在跑）
  testRegex: '.*\\.spec\\.ts$',
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/test/.*\\.e2e-spec\\.ts$'],
  transform: {
    // allowJs：Nest 12 发布的是 .js，得让 ts-jest 也处理它。
    // module: commonjs：tsconfig 里是 nodenext，而 @nestjs/common 的 package.json
    // 带 "type": "module"，按 nodenext 编译出来还是 ESM —— 必须在测试里压成 CJS。
    '^.+\\.(t|j)s$': [
      'ts-jest',
      {
        tsconfig: {
          allowJs: true,
          module: 'commonjs',
          moduleResolution: 'node',
          esModuleInterop: true,
          isolatedModules: false,
        },
      },
    ],
  },
  // @nestjs/* 发布的是 ESM（package.json 里 type: module，没有 CJS 入口）。
  // Node 22 的 require(esm) 能在运行时装进来，但 jest 自己的 require 实现不行，
  // 所以这里让 ts-jest 处理它们；其余 node_modules 照旧跳过，保证测试启动速度。
  //
  // 两条 pattern 是给 pnpm 的目录形状准备的：
  //   .../node_modules/.pnpm/@nestjs+common@x/node_modules/@nestjs/common/index.js
  // 只写 `/node_modules/(?!@nestjs/)` 会在**内层**那个 node_modules 上命中，
  // 于是文件照样被跳过。所以要显式放行 `.pnpm/@nestjs*`。
  transformIgnorePatterns: [
    '/node_modules/(?!(@nestjs|\\.pnpm))',
    '/node_modules/\\.pnpm/(?!@nestjs)',
  ],
  moduleNameMapper: pathsToModuleNameMapper(paths, { prefix: '<rootDir>/' }),
  collectCoverageFrom: [
    'src/**/*.(t|j)s',
    'libs/**/*.(t|j)s',
    'apps/**/*.(t|j)s',
  ],
  coverageDirectory: './coverage',
  testEnvironment: 'node',
};

export default config;
