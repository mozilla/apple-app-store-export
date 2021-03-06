"use strict";

const fetch = require("node-fetch");
const readline = require("readline");

const { RequestError } = require("./requestError");

class AnalyticsClient {
  constructor() {
    this.apiBaseUrl = "https://appstoreconnect.apple.com/analytics/api/v1";
    this.defaultHeaders = {
      "Content-Type": "application/json",
      Accept: "application/json, text/javascript, */*",
    };
    this.cookies = {};
  }

  /**
   * Update stored cookies based on a response's set-cookie header
   */
  setCookies(response) {
    const regexMatches = [
      ...response.headers.get("set-cookie").matchAll(/\S+?=.+?;/g),
    ];
    regexMatches
      .map((m) => m[0].split("="))
      .forEach(([key, value]) => {
        this.cookies[key] = value;
      });
  }

  /**
   * Return default headers with cookie header set
   */
  get headers() {
    const cookies = Object.entries(this.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    return { ...this.defaultHeaders, Cookie: cookies };
  }

  /**
   * Check if the given response returned an error, throwing a RequestError
   * if there is an error
   */
  static checkResponseForError(response, startMessage, endMessage) {
    if (!response.ok) {
      throw new RequestError(
        `${startMessage}: ${response.status} ${response.statusText} ${
          endMessage || ""
        }`,
        response.status,
      );
    }
  }

  /**
   * Retrieve account and session cookies using username and password
   */
  async login(username, password, testCode) {
    const baseAuthUrl = "https://idmsa.apple.com/appleauth/auth";
    const sessionUrl = "https://appstoreconnect.apple.com/olympus/v1/session";
    const loginHeaders = {
      // static key that is required for all auth endpoints
      "X-Apple-Widget-Key":
        "e0b80c3bf78523bfe80974d320935bfa30add02e1bff88ec2166c6bd5a706c42",
    };

    // Initial login request
    let loginResponse = await fetch(
      `${baseAuthUrl}/signin?isRememberMeEnabled=true`,
      {
        method: "POST",
        body: JSON.stringify({
          accountName: username,
          password,
          rememberMe: false,
        }),
        headers: { ...this.headers, ...loginHeaders },
      },
    );

    if (!loginResponse.ok) {
      if (loginResponse.status === 409) {
        // 2SV request
        console.log("Attempting to handle 2-step verification");
        loginHeaders["X-Apple-ID-Session-Id"] = loginResponse.headers.get(
          "X-Apple-ID-Session-Id",
        );
        loginHeaders.scnt = loginResponse.headers.get("scnt");
        const codeRequestResponse = await fetch(baseAuthUrl, {
          headers: { ...this.headers, ...loginHeaders },
        });

        if (!codeRequestResponse.ok) {
          if (codeRequestResponse.status === 423) {
            console.log(
              "Too many codes requested, try again later or use last code",
            );
          } else {
            AnalyticsClient.checkResponseForError(
              codeRequestResponse,
              "Error requesting 2SV code",
            );
          }
        }

        let code;
        if (testCode) {
          code = testCode;
        } else {
          const prompt = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
          });

          code = await new Promise((resolve) => {
            prompt.question("Enter 2SV code: ", (input) => {
              resolve(input);
            });
          });
          prompt.close();
        }
        if (!code) {
          throw new Error("No 2SV code given");
        }

        // 2SV response is used like the initial login response
        loginResponse = await fetch(
          `${baseAuthUrl}/verify/phone/securitycode`,
          {
            method: "POST",
            body: JSON.stringify({
              mode: "sms",
              phoneNumber: { id: 1 },
              securityCode: {
                code,
              },
            }),
            headers: { ...this.headers, ...loginHeaders },
          },
        );
      } else if (loginResponse.status === 412) {
        // Skip adding 2SV to account
        loginHeaders["X-Apple-ID-Session-Id"] = loginResponse.headers.get(
          "X-Apple-ID-Session-Id",
        );
        loginHeaders.scnt = loginResponse.headers.get("scnt");

        // 2SV response is used like the initial login response
        loginResponse = await fetch(`${baseAuthUrl}/repair/complete`, {
          method: "POST",
          headers: { ...this.headers, ...loginHeaders },
        });

        AnalyticsClient.checkResponseForError(
          loginResponse,
          "Error skipping 2SV request",
        );
      } else {
        let message;
        if (loginResponse.status === 401) {
          message = "Invalid username and password";
        } else {
          message = "Unrecognized error";
        }
        AnalyticsClient.checkResponseForError(
          loginResponse,
          "Could not log in",
          message,
        );
      }
    }

    // Get account info cookie
    this.setCookies(loginResponse);
    if (this.cookies.myacinfo === undefined) {
      throw Error("Could not find account info cookie");
    }

    // Request session cookie
    const sessionResponse = await fetch(sessionUrl, {
      headers: this.headers,
    });

    AnalyticsClient.checkResponseForError(
      sessionResponse,
      "Could not get session cookie",
    );

    this.setCookies(sessionResponse);
    if (this.cookies.itctx === undefined) {
      throw Error("Could not find session cookie");
    }
  }

  /**
   * Throw an error if client has not been authenticated
   */
  isAuthenticated(name) {
    if (!this.cookies.myacinfo || !this.cookies.itctx) {
      throw new Error(
        `${name} function requires authentication; use login function first`,
      );
    }
  }

  /**
   * Retrieve API metadata (e.g. data date range, available metrics)
   */
  async getMetadata() {
    this.isAuthenticated("getMetadata");

    const settingsResponse = await fetch(`${this.apiBaseUrl}/settings/all`, {
      headers: this.headers,
    });

    const data = await settingsResponse.json();
    AnalyticsClient.checkResponseForError(
      settingsResponse,
      "Could not get API settings",
      data.errors,
    );

    return data;
  }

  /**
   * Get data for given metric grouped by given dimension over the date range.
   * If dimension is null or undefined then total is returned
   * startDate and endDate must be in ISO8601 date format YYYY-mm-dd
   */
  async getMetric(appId, metric, dimension, startDate, endDate) {
    this.isAuthenticated("getMetrics");

    const requestBody = {
      adamId: [appId],
      measures: metric instanceof Array ? metric : [metric],
      group: dimension
        ? {
            dimension,
            metric,
            limit: 10,
            rank: "DESCENDING",
          }
        : null,
      frequency: "day",
      startTime: `${startDate}T00:00:00Z`,
      endTime: `${endDate}T00:00:00Z`,
    };

    const metricsResponse = await fetch(
      "https://appstoreconnect.apple.com/analytics/api/v1/data/time-series",
      {
        method: "POST",
        body: JSON.stringify(requestBody),
        headers: {
          ...this.headers,
          "X-Requested-By": "dev.apple.com",
        },
      },
    );

    const data = await metricsResponse.json();
    AnalyticsClient.checkResponseForError(
      metricsResponse,
      "Could not get metrics",
      `\n${JSON.stringify(data.errors, null, 2) || ""}`,
    );
    return data;
  }
}

exports.AnalyticsClient = AnalyticsClient;
