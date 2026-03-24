"use strict";

function loadEnv() {
  try {
    // In Docker we already pass env vars via compose/env_file.
    // This keeps local node usage working without hard-failing when dotenv is unavailable.
    require("dotenv").config();
  } catch (error) {
    if (error && error.code !== "MODULE_NOT_FOUND") {
      throw error;
    }
  }
}

module.exports = { loadEnv };
