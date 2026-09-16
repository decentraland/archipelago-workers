module.exports = {
  projects: [
    "<rootDir>/ws-connector/jest.config.js",
    "<rootDir>/stats/jest.config.js",
  ],
  collectCoverage: true,
  coverageDirectory: "<rootDir>/coverage",
  coverageReporters: ["lcov", "text"],
};
