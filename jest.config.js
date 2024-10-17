module.exports = {
  projects: [
    "<rootDir>/core/jest.config.js",
    "<rootDir>/ws-connector/jest.config.js",
    "<rootDir>/stats/jest.config.js",
  ],
  collectCoverage: true,
  coverageDirectory: "<rootDir>/coverage",
  coverageReporters: ["lcov", "text"],
};
