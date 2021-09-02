const fs = require("fs");
const express = require("express");
const fetch = require("node-fetch");
const prom = require("prom-client");
const yaml = require("js-yaml");

const config = yaml.load(fs.readFileSync(process.argv[2] ?? "config.yml"));

const PROJECT_ID = config.google_device_access.project_id;
const CLIENT_ID = config.google_device_access.client_id;
const CLIENT_SECRET = config.google_device_access.client_secret;
const REFRESH_TOKEN = config.google_device_access.refresh_token;

console.log({ PROJECT_ID, CLIENT_ID, CLIENT_SECRET, REFRESH_TOKEN });

async function getAccessToken() {
  const url = `https://www.googleapis.com/oauth2/v4/token?client_id=${CLIENT_ID}&client_secret=${CLIENT_SECRET}&refresh_token=${REFRESH_TOKEN}&grant_type=refresh_token`;
  console.log(`POSTing ${url}`);
  const resp = await fetch(url, { method: "POST" });
  const data = await resp.json();
  console.log(data);
  if (data.error) {
    console.error(data);
    throw new Error(data.error);
  }
  setTimeout(() => {
    console.log("Refreshing access token...");
    accessTokenPromise = getAccessToken();
  }, data.expires_in * 1_000);
  return data.access_token;
}
let accessTokenPromise = getAccessToken();

async function getEndpoint(route) {
  const accessToken = await accessTokenPromise;
  const url = `https://smartdevicemanagement.googleapis.com/v1/enterprises/${PROJECT_ID}/${route}`;
  const resp = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
  });
  const data = await resp.json();
  if (data.error) {
    console.error(data);
    throw new Error(data.error);
  }
  return data;
}

getEndpoint("devices").then(console.log);
