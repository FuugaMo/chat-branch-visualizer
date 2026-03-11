(function initCbvReportingConfig(global) {
  'use strict';

  const config = {
    enabled: true,
    endpoint: 'https://chat-branch-visualizer.vercel.app/api/reports',
    publicKey: 'cbv-report-v1',
    autoSend: false,
    manualReports: false,
    requestTimeoutMs: 8000,
    dedupeWindowMs: 30 * 60 * 1000,
  };

  global.CBV_REPORTING_CONFIG = Object.freeze(config);
  global.cbvGetReportingConfig = function cbvGetReportingConfig() {
    return global.CBV_REPORTING_CONFIG;
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
