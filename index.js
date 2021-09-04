const fs = require("fs");
const express = require("express");
const fetch = require("node-fetch");
const prom = require("prom-client");
const yaml = require("js-yaml");

const config = yaml.load(fs.readFileSync(process.argv[2] ?? "config.yml"));

const PORT = 9896 || process.env.PORT;
const PROJECT_ID = config?.google_device_access?.project_id;
const CLIENT_ID = config?.google_device_access?.client_id;
const CLIENT_SECRET = config?.google_device_access?.client_secret;
const REFRESH_TOKEN = config?.google_device_access?.refresh_token;

if (!PROJECT_ID || !CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN)
  throw new Error("Invalid configuration");

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  console.log(`${req.method} ${req.url}`);
  next();
});

prom.collectDefaultMetrics();

/*
key: string
arr: { val: any, ...labels }[]
doc?: { help: string, type: "counter" | "gauge" | "histogram" | "summary" }
*/
function createMetricString(key, arr, doc) {
  let str = "";
  if (doc) {
    str += doc.help ? `# HELP ${key} ${doc.help}\n` : "";
    str += doc.type ? `# TYPE ${key} ${doc.type}\n` : "";
  }
  for (const { val, ...labels } of arr) {
    const labelEntries = Object.entries(labels);
    const labelStr =
      labelEntries.length &&
      labelEntries
        .reduce((acc, [k, v]) => (acc += `,${k}="${v}"`), "")
        .slice(1);
    str += `${key}${labelStr ? `{${labelStr}}` : ""} ${val}\n`;
  }
  return str.trim();
}

const docTable = {
  nest_device_fan_on: {
    help: "Whether the device has a fan timer running. Either 0 or 1.",
    type: "gauge",
  },
  nest_device_humidity_ratio: {
    help: "Ambient humidity as measured by the device. Between 0 and 1.",
    type: "gauge",
  },
  nest_device_temperature_celsius: {
    help: "Ambient temperature as measured by the device.",
    type: "gauge",
  },
  nest_thermostat_eco_on: {
    help: "Whether the thermostat is currently in Eco mode. Either 0 or 1.",
    type: "gauge",
  },
  nest_thermostat_hvac_mode: {
    help: "The thermostat's current HVAC output, expressed in 'mode' label as 'HEATING', 'COOLING', or 'OFF'. Value is 0 if mode is OFF, otherwise 1.",
    type: "gauge",
  },
  nest_thermostat_mode: {
    help: "The thermostat's current mode, expressed in 'mode' label as 'HEAT', 'COOL', 'HEATCOOL', or 'OFF'. Value is 0 if mode is OFF, otherwise 1.",
    type: "gauge",
  },
  nest_thermostat_heat_setpoint_celsius: {
    help: "The temperature the thermostat is currently configured to heat to.",
    type: "gauge",
  },
  nest_thermostat_cool_setpoint_celsius: {
    help: "The temperature the thermostat is currently configured to cool to.",
    type: "gauge",
  },
};

const traitTable = {
  "sdm.devices.traits.Fan"(obj) {
    return [["nest_device_fan_on", Number(obj.timerMode !== "OFF")]];
  },
  "sdm.devices.traits.Humidity"(obj) {
    return [["nest_device_humidity_ratio", obj.ambientHumidityPercent / 100]];
  },
  "sdm.devices.traits.Temperature"(obj) {
    return [["nest_device_temperature_celsius", obj.ambientTemperatureCelsius]];
  },
  "sdm.devices.traits.ThermostatEco"(obj) {
    return [["nest_thermostat_eco_on", Number(obj.mode !== "OFF")]];
  },
  "sdm.devices.traits.ThermostatHvac"(obj) {
    return [
      [
        "nest_thermostat_hvac_mode",
        Number(obj.status !== "OFF"),
        { mode: obj.status },
      ],
    ];
  },
  "sdm.devices.traits.ThermostatMode"(obj) {
    return [
      ["nest_thermostat_mode", Number(obj.mode !== "OFF"), { mode: obj.mode }],
    ];
  },
  "sdm.devices.traits.ThermostatTemperatureSetpoint"(obj) {
    return [
      obj.headCelsius
        ? ["nest_thermostat_heat_setpoint_celsius", obj.heatCelsius]
        : null,
      obj.coolCelsius
        ? ["nest_thermostat_cool_setpoint_celsius", obj.coolCelsius]
        : null,
    ];
  },
};

function devicesToMetrics(obj, requestedStructure) {
  const metricsDict = obj
    .flatMap((device) => {
      const [, id] = device.name.match(/^enterprises\/.+\/devices\/(.+)$/);
      const [, structure, room] = device.assignee.match(
        /^enterprises\/.+\/structures\/(.+)\/rooms\/(.+)$/
      );
      if (structure !== requestedStructure) return [];
      const parent = device.parentRelations[0].displayName;
      const labels = { device: id, room, parent };
      return Object.entries(device.traits) // {[string]: object} => [string, object][]
        .flatMap(([key, val]) => traitTable[key]?.(val)) // [string, object] => [string, number] | null
        .filter((x) => x != null)
        .map(([key, val, etc]) => [key, { val, ...labels, ...etc }]); // [string, number] => [string, {val: number, ...labels}]
    })
    .reduce((acc, [key, val]) => {
      (acc[key] ??= []).push(val);
      return acc;
    }, {});
  return Object.entries(metricsDict)
    .map(([key, arr]) => createMetricString(key, arr, docTable[key]))
    .join("\n");
}

async function getAccessToken() {
  const url = `https://www.googleapis.com/oauth2/v4/token?client_id=${CLIENT_ID}&client_secret=${CLIENT_SECRET}&refresh_token=${REFRESH_TOKEN}&grant_type=refresh_token`;
  const resp = await fetch(url, { method: "POST" });
  const data = await resp.json();
  if (data.error) {
    console.error(data);
    throw new Error(data.error);
  }
  console.log("Successfully obtained access token");
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

app.get("/devices", async (req, res) => {
  const data = await getEndpoint("devices");
  const structure = req.query.target;
  if (!structure) {
    res.status(400).send("target parameter required");
  } else {
    const metrics = devicesToMetrics(data.devices, structure);
    res.set("Content-Type", "text/plain").send(metrics);
  }
});

app.get("/metrics", async (req, res) =>
  res.set("Content-Type", "text/plain").send(await prom.register.metrics())
);

app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
