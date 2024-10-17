module.exports = {
  moduleFileExtensions: ['ts', 'js'],
  transform: {
    '^.+\\.(ts|tsx)$': ['ts-jest', { tsconfig: '<rootDir>/test/tsconfig.json' }]
  },
  coverageDirectory: '<rootDir>/coverage',
  collectCoverageFrom: ['src/**/*.ts', 'src/**/*.js'],
  coveragePathIgnorePatterns: ['/node_modules/', '/src/proto/'],
  testMatch: ['<rootDir>/test/**/*.spec.ts'],
  testEnvironment: 'node'
}
