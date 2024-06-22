#!/usr/bin/env node

import { Command } from "commander";
import inquirer from "inquirer";
import fs from "fs-extra";
import path from "path";
import { fileURLToPath } from "url";
import { exec } from "child_process";
import chalk from "chalk";

const program = new Command();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

program
  .version("1.0.0")
  .description("CLI to create a Zustand store")
  .action(() => {
    console.log(
      chalk.blue.bold(`
      ╔════════════════════════════════════════╗
      ║                                        ║
      ║        Zustand Store CLI Tool          ║
      ║    Easily create and manage stores     ║
      ║                                        ║
      ╚════════════════════════════════════════╝
        `)
    );

    const defaultConfigPath = path.join(
      process.cwd(),
      "zustand-store-config.json"
    );
    let defaultConfig = {};

    if (fs.existsSync(defaultConfigPath)) {
      try {
        defaultConfig = fs.readJsonSync(defaultConfigPath);
        console.log(chalk.green("✔ Loaded default configuration."));

        // Parse initial state if it's a string
        if (typeof defaultConfig.initialState === "string") {
          defaultConfig.initialState = JSON.parse(defaultConfig.initialState);
        }
      } catch (error) {
        console.log(
          chalk.red("✘ Failed to load default configuration:"),
          error.message
        );
      }
    }

    inquirer
      .prompt([
        {
          type: "input",
          name: "storeName",
          message: chalk.green("➤ What is the name of your store?"),
          default: defaultConfig.storeName || "useStore",
        },
        {
          type: "list",
          name: "fileType",
          message: chalk.green("➤ Choose the file type:"),
          choices: ["JavaScript", "TypeScript"],
          default: defaultConfig.fileType || "JavaScript",
        },
        {
          type: "confirm",
          name: "addPersist",
          message: chalk.green("➤ Do you want to add persistence?"),
          default: defaultConfig.addPersist || false,
        },
        {
          type: "input",
          name: "initialState",
          message: chalk.green(
            '➤ Define initial state properties (as JSON, e.g., {"count":0} or {"user":{"name":"John","age":30}}):'
          ),
          default: JSON.stringify(defaultConfig.initialState || {}),
        },
        {
          type: "input",
          name: "actions",
          message: chalk.green(
            "➤ Define actions (comma-separated, e.g., increment,reset):"
          ),
          default: defaultConfig.actions || "",
        },
        {
          type: "list",
          name: "packageManager",
          message: chalk.green("➤ Choose your package manager:"),
          choices: ["npm", "yarn"],
          default: defaultConfig.packageManager || "npm",
        },
        {
          type: "input",
          name: "storePath",
          message: chalk.green(
            "➤ Enter the custom path for the store directory:"
          ),
          default: defaultConfig.storePath || "store",
        },
        {
          type: "confirm",
          name: "saveConfig",
          message: chalk.green(
            "➤ Do you want to save these settings as default?"
          ),
          default: false,
        },
      ])
      .then((answers) => {
        const {
          storeName,
          fileType,
          addPersist,
          initialState,
          actions,
          packageManager,
          storePath,
          saveConfig,
        } = answers;

        let parsedInitialState;
        try {
          parsedInitialState = JSON.parse(initialState);
        } catch (error) {
          console.error(
            chalk.red("✘ Error parsing initial state JSON:"),
            error.message
          );
          process.exit(1);
        }

        createStore(
          storeName,
          fileType,
          addPersist,
          parsedInitialState,
          actions,
          packageManager,
          storePath
        );

        if (saveConfig) {
          saveConfiguration({ ...answers, initialState: parsedInitialState });
        }
      });
  });

program.parse(process.argv);

function createStore(
  storeName,
  fileType,
  addPersist,
  initialState,
  actions,
  packageManager,
  storePath
) {
  const storeDir = path.join(process.cwd(), storePath);

  // Ensure the store directory exists
  fs.ensureDirSync(storeDir);

  // Determine the file extension and template based on the file type
  const fileExtension = fileType === "TypeScript" ? "ts" : "js";
  const templateFileName = addPersist
    ? `store-persist.${fileExtension}`
    : `store.${fileExtension}`;

  // Create the store file path
  const storeFilePath = path.join(storeDir, `${storeName}.${fileExtension}`);

  // Get template content
  const templateFilePath = path.join(
    __dirname,
    `../templates/${templateFileName}`
  );

  if (!fs.existsSync(templateFilePath)) {
    console.error(chalk.red(`✘ Template file not found: ${templateFilePath}`));
    process.exit(1);
  }

  let storeFileContent = fs.readFileSync(templateFilePath, "utf8");

  // Convert initial state and actions to appropriate formats
  const initialStateObject = JSON.stringify(initialState, null, 2).replace(
    /"([^"]+)":/g,
    "$1:"
  );
  const initialStateTypes = generateTypes(initialState).join(";\n  ");

  const actionDefinitions = actions
    .split(",")
    .map((action) => `${action}: () => void`)
    .join(";\n  ");
  const actionImplementations = actions
    .split(",")
    .map((action) => `${action}: () => set((state) => ({}))`)
    .join(",\n    ");

  // Replace placeholders in the template content
  storeFileContent = storeFileContent.replace(/__STORE_NAME__/g, storeName);
  storeFileContent = storeFileContent.replace(
    "__INITIAL_STATE__",
    initialStateObject.slice(1, -1)
  ); // Remove outer braces
  storeFileContent = storeFileContent.replace(
    "__INITIAL_STATE_TYPES__",
    initialStateTypes
  );
  storeFileContent = storeFileContent.replace(
    "__ACTIONS_TYPES__",
    actionDefinitions
  );
  storeFileContent = storeFileContent.replace(
    "__ACTIONS__",
    actionImplementations
  );

  // Write the content to the store file
  fs.writeFileSync(storeFilePath, storeFileContent);

  // Install zustand if not installed
  const dependencies = ["zustand"];

  exec(
    `${packageManager} list ${dependencies.join(" ")}`,
    (error, stdout, stderr) => {
      if (error || stderr.includes("not found")) {
        console.log(chalk.yellow(`⚙ Installing ${dependencies.join(" ")}...`));
        exec(
          `${packageManager} ${
            packageManager === "yarn" ? "add" : "install"
          } ${dependencies.join(" ")}`,
          (error, stdout, stderr) => {
            if (error) {
              console.error(
                chalk.red(`✘ Error installing ${dependencies.join(" ")}:`),
                error
              );
              return;
            }
            console.log(
              chalk.green(`✔ ${dependencies.join(" ")} installed successfully.`)
            );
          }
        );
      } else {
        console.log(
          chalk.green(`✔ ${dependencies.join(" ")} is already installed.`)
        );
      }
    }
  );

  console.log(
    chalk.blue(
      `✔ Zustand store "${storeName}" created successfully in the "${storePath}" directory.`
    )
  );
}

function inferType(value) {
  if (Array.isArray(value)) {
    return "any[]";
  }
  switch (typeof value) {
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "object":
      return value === null ? "null" : "object";
    default:
      return "string";
  }
}

function generateTypes(obj, prefix = "") {
  const entries = Object.entries(obj);
  return entries.map(([key, value]) => {
    const type = inferType(value);
    if (type === "object" && value !== null) {
      return `${prefix}${key}: {\n    ${generateTypes(value, "").join(
        ";\n    "
      )}\n  }`;
    }
    return `${prefix}${key}: ${type}`;
  });
}

function saveConfiguration(config) {
  const configPath = path.join(process.cwd(), "zustand-store-config.json");
  fs.writeJsonSync(configPath, config, { spaces: 2 });
  console.log(chalk.blue("✔ Configuration saved to zustand-store-config.json"));
}
