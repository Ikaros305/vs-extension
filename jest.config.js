module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/test/**/*.test.ts'],
  moduleNameMapper: {
    '^vscode$': '<rootDir>/node_modules/@types/vscode/index.d.ts',
  },
};
