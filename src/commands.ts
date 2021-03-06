import { readFileSync } from 'fs';
/**
 * Clasp command method bodies.
 */
import chalk from 'chalk';
import * as commander from 'commander';
import * as del from 'del';
import * as fuzzy from 'fuzzy';
import { script_v1 } from 'googleapis';
import * as pluralize from 'pluralize';
import { watchTree } from 'watch';
import { PUBLIC_ADVANCED_SERVICES, SCRIPT_TYPES } from './apis';
import {
  authorize,
  discovery,
  drive,
  getLocalScript,
  loadAPICredentials,
  logger,
  script,
  serviceUsage,
} from './auth';
import { DOT, DOTFILE, ProjectSettings } from './dotfile';
import { fetchProject, getProjectFiles, hasProject, pushFiles } from './files';
import { enableOrDisableAdvanceServiceInManifest, manifestExists, readManifest } from './manifest';
import {
  ERROR,
  LOG,
  PROJECT_MANIFEST_BASENAME,
  URL,
  checkIfOnline,
  getDefaultProjectName,
  getProjectId,
  getProjectSettings,
  getWebApplicationURL,
  hasOauthClientSettings,
  logError,
  saveProject,
  spinner,
  validateManifest,
} from './utils';

const ellipsize = require('ellipsize');
const open = require('opn');
const inquirer = require('inquirer');
const padEnd = require('string.prototype.padend');

// setup inquirer
const prompt = inquirer.prompt;
inquirer.registerPrompt('autocomplete', require('inquirer-autocomplete-prompt'));

/**
 * Force downloads all Apps Script project files into the local filesystem.
 * @param cmd.version {number} The version number of the project to retrieve.
 *                             If not provided, the project's HEAD version is returned.
 */
export const pull = async (cmd: { versionNumber: number }) => {
  await checkIfOnline();
  const { scriptId, rootDir } = await getProjectSettings();
  if (scriptId) {
    spinner.setSpinnerTitle(LOG.PULLING);
    fetchProject(scriptId, rootDir, cmd.versionNumber);
  }
};

/**
 * Uploads all files into the script.google.com filesystem.
 * TODO: Only push when a non-ignored file is changed.
 * TODO: Only push the specific files that changed (rather than all files).
 * @param cmd.watch {boolean} If true, runs `clasp push` when any local file changes. Exit with ^C.
 */
export const push = async (cmd: { watch: boolean }) => {
  await checkIfOnline();
  await loadAPICredentials();
  await validateManifest();
  if (cmd.watch) {
    console.log(LOG.PUSH_WATCH);
    // @see https://www.npmjs.com/package/watch
    watchTree('.', (f, curr, prev) => {
      // The first watch doesn't give a string for some reason.
      if (typeof f === 'string') {
        console.log(`\n${LOG.PUSH_WATCH_UPDATED(f)}\n`);
      }
      console.log(LOG.PUSHING);
      pushFiles();
    });
  } else {
    spinner.setSpinnerTitle(LOG.PUSHING).start();
    pushFiles();
  }
};

/**
 * Outputs the help command.
 */
export const help = async () => {
  commander.outputHelp();
  process.exit(0);
};

/**
 * Displays a default message when an unknown command is typed.
 * @param command {string} The command that was typed.
 */
export const defaultCmd = async (command: string) => {
  logError(null, ERROR.COMMAND_DNE(command));
};

/**
 * Creates a new Apps Script project.
 * @param cmd.type {string} The type of the Apps Script project.
 * @param cmd.title {string} The title of the Apps Script project's file
 * @param cmd.parentId {string} The Drive ID of the G Suite doc this script is bound to.
 * @param cmd.rootDir {string} Specifies the local directory in which clasp will store your project files.
 *                    If not specified, clasp will default to the current directory.
 */
export const create = async (cmd: { type: string; title: string; parentId: string; rootDir: string }) => {
  // Handle common errors.
  await checkIfOnline();
  if (hasProject()) return logError(null, ERROR.FOLDER_EXISTS);
  await loadAPICredentials();

  // Create defaults.
  const title = cmd.title || getDefaultProjectName();
  let { type } = cmd;
  let { parentId } = cmd;

  if (!type) {
    const answers = await prompt([
      {
        type: 'list',
        name: 'type',
        message: 'Clone which script? ',
        choices: Object.keys(SCRIPT_TYPES).map(key => SCRIPT_TYPES[key as any]),
      },
    ]);
    type = answers.type;
  }

  // Create files with MIME type.
  // https://developers.google.com/drive/api/v3/mime-types
  const DRIVE_FILE_MIMETYPES: { [key: string]: string } = {
    [SCRIPT_TYPES.DOCS]: 'application/vnd.google-apps.document',
    [SCRIPT_TYPES.FORMS]: 'application/vnd.google-apps.form',
    [SCRIPT_TYPES.SHEETS]: 'application/vnd.google-apps.spreadsheet',
    [SCRIPT_TYPES.SLIDES]: 'application/vnd.google-apps.presentation',
  };
  const driveFileType = DRIVE_FILE_MIMETYPES[type];
  if (driveFileType) {
    spinner.setSpinnerTitle(LOG.CREATE_DRIVE_FILE_START(type)).start();
    const driveFile = await drive.files.create({
      requestBody: {
        mimeType: driveFileType,
        name: title,
      },
    });
    parentId = driveFile.data.id || '';
    spinner.stop(true);
    console.log(LOG.CREATE_DRIVE_FILE_FINISH(type, parentId));
  }

  // CLI Spinner
  spinner.setSpinnerTitle(LOG.CREATE_PROJECT_START(title)).start();
  try {
    const { scriptId } = await getProjectSettings(true);
    if (scriptId) {
      logError(null, ERROR.NO_NESTED_PROJECTS);
      process.exit(1);
    }
  } catch (err) {
    // no scriptId (because project doesn't exist)
    // console.log(err);
  }

  // Create a new Apps Script project
  const res = await script.projects.create({
    requestBody: {
      title,
      parentId,
    },
  });
  spinner.stop(true);
  if (res.status !== 200) {
    if (parentId) {
      console.log(res.statusText, ERROR.CREATE_WITH_PARENT);
    }
    logError(res.statusText, ERROR.CREATE);
  } else {
    const createdScriptId = res.data.scriptId || '';
    console.log(LOG.CREATE_PROJECT_FINISH(type, createdScriptId));
    const rootDir = cmd.rootDir;
    saveProject(createdScriptId, rootDir);
    if (!manifestExists()) {
      fetchProject(createdScriptId, rootDir); // fetches appsscript.json, o.w. `push` breaks
    }
  }
};

/**
 * Fetches an Apps Script project.
 * Prompts the user if no script ID is provided.
 * @param scriptId {string} The Apps Script project ID to fetch.
 * @param versionNumber {string} An optional version to pull the script from.
 */
export const clone = async (scriptId: string, versionNumber?: number) => {
  await checkIfOnline();
  if (hasProject()) return logError(null, ERROR.FOLDER_EXISTS);
  if (!scriptId) {
    await loadAPICredentials();
    const list = await drive.files.list({
      // pageSize: 10,
      // fields: 'files(id, name)',
      orderBy: 'modifiedByMeTime desc',
      q: 'mimeType="application/vnd.google-apps.script"',
    });
    const data = list.data;
    if (!data) return logError(list.statusText, 'Unable to use the Drive API.');
    const files = data.files;
    if (!files || !files.length) return console.log(LOG.FINDING_SCRIPTS_DNE);
    const fileIds = files.map((file: any) => {
      return {
        name: `${padEnd(file.name, 20)} – ${LOG.SCRIPT_LINK(file.id)}`,
        value: file.id,
      };
    });
    const answers = await prompt([
      {
        type: 'list',
        name: 'scriptId',
        message: 'Clone which script? ',
        choices: fileIds,
        pageSize: 30,
      },
    ]);
    scriptId = answers.scriptId;
  } else {
    // We have a scriptId or URL
    // If we passed a URL, extract the scriptId from that. For example:
    // https://script.google.com/a/DOMAIN/d/1Ng7bNZ1K95wNi2H7IUwZzM68FL6ffxQhyc_ByV42zpS6qAFX8pFsWu2I/edit
    if (scriptId.length !== 57) {
      // 57 is the magic number
      const ids = scriptId.split('/').filter(s => {
        return s.length === 57;
      });
      if (ids.length) {
        scriptId = ids[0];
      }
    } else {
      // We have a scriptId or URL
      // If we passed a URL, extract the scriptId from that.
      // e.g. https://script.google.com/a/DOMAIN/d/{ID}/edit
      if (scriptId.length !== 57) {
        // 57 is the magic number
        const ids = scriptId.split('/').filter(s => {
          return s.length === 57;
        });
        if (ids.length) {
          scriptId = ids[0];
        }
      }
      spinner.setSpinnerTitle(LOG.CLONING);
      saveProject(scriptId);
      fetchProject(scriptId, '', versionNumber);
    }
  }
  spinner.setSpinnerTitle(LOG.CLONING);
  saveProject(scriptId);
  fetchProject(scriptId, '', versionNumber);
};

/**
 * Logs the user in. Saves the client credentials to an either local or global rc file.
 * @param {object} options The login options.
 * @param {boolean?} options.localhost If true, authorizes without a HTTP server.
 * @param {string?} options.creds The location of credentials file.
 */
export const login = async (options: { localhost?: boolean; creds?: string }) => {
  // Local vs global checks
  const isLocalLogin = !!options.creds;
  const loggedInLocal = hasOauthClientSettings(true);
  const loggedInGlobal = hasOauthClientSettings(false);
  if (isLocalLogin && loggedInLocal) console.warn(ERROR.LOGGED_IN_LOCAL);
  if (!isLocalLogin && loggedInGlobal) console.warn(ERROR.LOGGED_IN_GLOBAL);
  console.log(LOG.LOGIN(isLocalLogin));
  await checkIfOnline();

  // Localhost check
  const useLocalhost = !!options.localhost;

  // Using own credentials.
  if (options.creds) {
    // First read the manifest to detect any additional scopes in "oauthScopes" fields.
    // In the script.google.com UI, these are found under File > Project Properties > Scopes
    const { oauthScopes } = await readManifest();

    // Read credentials file.
    const credsFile = readFileSync(options.creds, 'utf8');
    const credentials = JSON.parse(credsFile);
    await authorize({
      useLocalhost,
      creds: credentials,
      additionalScopes: oauthScopes,
    });
  } else {
    // Not using own credentials
    await authorize({
      useLocalhost,
    });
  }
  process.exit(0); // gracefully exit after successful login
};

/**
 * Logs out the user by deleting credentials.
 */
export const logout = async () => {
  if (hasOauthClientSettings(true)) del(DOT.RC.ABSOLUTE_LOCAL_PATH, { force: true });
  // del doesn't work with a relative path (~)
  if (hasOauthClientSettings()) del(DOT.RC.ABSOLUTE_PATH, { force: true });
};

/**
 * Prints StackDriver logs from this Apps Script project.
 * @param cmd.json {boolean} If true, the command will output logs as json.
 * @param cmd.open {boolean} If true, the command will open the StackDriver logs website.
 * @param cmd.setup {boolean} If true, the command will help you setup logs.
 * @param cmd.watch {boolean} If true, the command will watch for logs and print them. Exit with ^C.
 */
export const logs = async (cmd: { json: boolean; open: boolean; setup: boolean; watch: boolean }) => {
  await checkIfOnline();
  /**
   * This object holds all log IDs that have been printed to the user.
   * This prevents log entries from being printed multiple times.
   * StackDriver isn't super reliable, so it's easier to get generous chunk of logs and filter them
   * rather than filter server-side.
   * @see logs.data.entries[0].insertId
   */
  const logEntryCache: { [key: string]: boolean } = {};

  /**
   * Prints log entries
   * @param entries {any[]} StackDriver log entries.
   */
  function printLogs(entries: any[] = []) {
    entries = entries.reverse(); // print in syslog ascending order
    for (let i = 0; i < 50 && entries ? i < entries.length : i < 0; ++i) {
      const { severity, timestamp, resource, textPayload, protoPayload, jsonPayload, insertId } = entries[i];
      let functionName = resource.labels.function_name;
      functionName = functionName ? padEnd(functionName, 15) : ERROR.NO_FUNCTION_NAME;
      let payloadData: any = '';
      if (cmd.json) {
        payloadData = JSON.stringify(entries[i], null, 2);
      } else {
        const data: any = {
          textPayload,
          // chokes on unmatched json payloads
          // jsonPayload: jsonPayload ? jsonPayload.fields.message.stringValue : '',
          jsonPayload: jsonPayload ? JSON.stringify(jsonPayload).substr(0, 255) : '',
          protoPayload,
        };
        payloadData = data.textPayload || data.jsonPayload || data.protoPayload || ERROR.PAYLOAD_UNKNOWN;
        if (payloadData && payloadData['@type'] === 'type.googleapis.com/google.cloud.audit.AuditLog') {
          payloadData = LOG.STACKDRIVER_SETUP;
          functionName = padEnd(protoPayload.methodName, 15);
        }
        if (payloadData && typeof payloadData === 'string') {
          payloadData = padEnd(payloadData, 20);
        }
      }
      const coloredStringMap: any = {
        ERROR: chalk.red(severity),
        INFO: chalk.cyan(severity),
        DEBUG: chalk.green(severity), // includes timeEnd
        NOTICE: chalk.magenta(severity),
        WARNING: chalk.yellow(severity),
      };
      let coloredSeverity: string = coloredStringMap[severity] || severity;
      coloredSeverity = padEnd(String(coloredSeverity), 20);
      // If we haven't logged this entry before, log it and mark the cache.
      if (!logEntryCache[insertId]) {
        console.log(`${coloredSeverity} ${timestamp} ${functionName} ${payloadData}`);
        logEntryCache[insertId] = true;
      }
    }
  }
  async function setupLogs(projectId?: string): Promise<string> {
    const promise = new Promise<string>((resolve, reject) => {
      getProjectSettings().then(projectSettings => {
        console.log(`Open this link: ${LOG.SCRIPT_LINK(projectSettings.scriptId)}\n`);
        console.log(`Go to *Resource > Cloud Platform Project...* and copy your projectId
(including "project-id-")\n`);
        prompt([
          {
            type: 'input',
            name: 'projectId',
            message: 'What is your GCP projectId?',
          },
        ])
          .then((answers: any) => {
            projectId = answers.projectId;
            const dotfile = DOTFILE.PROJECT();
            if (!dotfile) return reject(logError(null, ERROR.SETTINGS_DNE));
            dotfile
              .read()
              .then((settings: ProjectSettings) => {
                if (!settings.scriptId) logError(ERROR.SCRIPT_ID_DNE);
                dotfile.write(Object.assign(settings, { projectId }));
                resolve(projectId);
              })
              .catch((err: object) => {
                reject(logError(err));
              });
          })
          .catch((err: any) => {
            reject(console.log(err));
          });
      });
    });
    promise.catch(err => {
      logError(err);
      spinner.stop(true);
    });
    return promise;
  }
  // Get project settings.
  let { projectId } = await getProjectSettings();
  projectId = cmd.setup ? await setupLogs() : projectId;
  if (!projectId) {
    console.log(LOG.NO_GCLOUD_PROJECT);
    projectId = await setupLogs();
    console.log(LOG.LOGS_SETUP);
  }
  // If we're opening the logs, get the URL, open, then quit.
  if (cmd.open) {
    const url = URL.LOGS(projectId);
    console.log(`Opening logs: ${url}`);
    return open(url, { wait: false });
  }

  /**
   * Fetches the logs and prints the to the user.
   * @param startDate {Date?} Get logs from this date to now.
   */
  async function fetchAndPrintLogs(startDate?: Date) {
    spinner.setSpinnerTitle(`${oauthSettings.isLocalCreds ? LOG.LOCAL_CREDS : ''}${LOG.GRAB_LOGS}`).start();
    // Create a time filter (timestamp >= "2016-11-29T23:00:00Z")
    // https://cloud.google.com/logging/docs/view/advanced-filters#search-by-time
    let filter = '';
    if (startDate) {
      filter = `timestamp >= "${startDate.toISOString()}"`;
    }
    const logs = await logger.entries.list({
      requestBody: {
        resourceNames: [`projects/${projectId}`],
        filter,
        orderBy: 'timestamp desc',
      },
    });

    // We have an API response. Now, check the API response status.
    spinner.stop(true);
    console.log(filter);
    if (logs.status !== 200) {
      switch (logs.status) {
        case 401:
          logError(null, oauthSettings.isLocalCreds ? ERROR.UNAUTHENTICATED_LOCAL : ERROR.UNAUTHENTICATED);
        case 403:
          logError(
            null,
            oauthSettings.isLocalCreds ? ERROR.PERMISSION_DENIED_LOCAL : ERROR.PERMISSION_DENIED,
          );
        default:
          logError(null, `(${logs.status}) Error: ${logs.statusText}`);
      }
    } else {
      printLogs(logs.data.entries);
    }
  }

  // Otherwise, if not opening StackDriver, load StackDriver logs.
  const oauthSettings = await loadAPICredentials();
  if (cmd.watch) {
    const POLL_INTERVAL = 6000; // 6s
    setInterval(() => {
      const startDate = new Date();
      startDate.setSeconds(startDate.getSeconds() - (10 * POLL_INTERVAL) / 1000);
      fetchAndPrintLogs(startDate);
    }, POLL_INTERVAL);
  } else {
    fetchAndPrintLogs();
  }
};

/**
 * Executes an Apps Script function. Requires clasp login --creds.
 * @param functionName {string} The function name within the Apps Script project.
 * @param cmd.nondev {boolean} If we want to run the last deployed version vs the latest code.
 * @see https://developers.google.com/apps-script/api/how-tos/execute
 * @requires `clasp login --creds` to be run beforehand.
 */
export const run = async (functionName: string, cmd: { nondev: boolean }) => {
  await checkIfOnline();
  await loadAPICredentials();
  const localScript = await getLocalScript();
  const { scriptId } = await getProjectSettings(true);

  const devMode = !cmd.nondev; // default true

  // Get the list of functions.
  if (!functionName) {
    spinner.setSpinnerTitle(`Getting functions`).start();
    const content = await script.projects.getContent({
      scriptId,
    });
    spinner.stop(true);
    if (content.status !== 200) {
      return logError(content.statusText);
    }
    const files = content.data.files || [];
    type TypeFunction = script_v1.Schema$GoogleAppsScriptTypeFunction;
    const functionNames: string[] = files
      .reduce((functions: TypeFunction[], file) => {
        if (!file.functionSet || !file.functionSet.values) return functions;
        return functions.concat(file.functionSet.values);
      }, [])
      .map((func: TypeFunction) => func.name) as string[];
    const answers = await prompt([
      {
        name: 'functionName',
        message: 'Select a functionName',
        type: 'autocomplete',
        source: (answers: object, input = '') => {
          // Returns a Promise
          // https://www.npmjs.com/package/inquirer-autocomplete-prompt#options
          return new Promise(resolve => {
            // Example: https://github.com/mokkabonna/inquirer-autocomplete-prompt/blob/master/example.js#L76
            const filtered = fuzzy.filter(input, functionNames);
            const original = filtered.map(el => {
              return el.original;
            });
            resolve(original);
          });
        },
      },
    ]);
    functionName = answers.functionName;
  }

  try {
    spinner.setSpinnerTitle(`Running function: ${functionName}`).start();
    const res = await localScript.scripts.run({
      scriptId,
      requestBody: {
        function: functionName,
        devMode,
      },
    });
    spinner.stop(true);
    if (!res || !res.data.done) {
      logError(null, ERROR.RUN_NODATA);
      process.exit(0); // exit gracefully in case localhost server spun up for authorize
    }
    const data = res.data;
    // @see https://developers.google.com/apps-script/api/reference/rest/v1/scripts/run#response-body
    if (data.response) {
      if (data.response.result) {
        console.log(data.response.result);
      } else {
        console.log(chalk.red('No response.'));
      }
    } else if (data.error && data.error.details) {
      // @see https://developers.google.com/apps-script/api/reference/rest/v1/scripts/run#Status
      console.error(
        `${chalk.red('Exception:')}`,
        data.error.details[0].errorType,
        data.error.details[0].errorMessage,
        data.error.details[0].scriptStackTraceElements || [],
      );
    }
  } catch (err) {
    spinner.stop(true);
    console.log(err);
    if (err) {
      // TODO move these to logError when stable?
      switch (err.code) {
        case 401:
          logError(null, ERROR.UNAUTHENTICATED_LOCAL);
        case 403:
          logError(null, ERROR.PERMISSION_DENIED_LOCAL);
        case 404:
          logError(null, ERROR.EXECUTE_ENTITY_NOT_FOUND);
        default:
          logError(null, `(${err.code}) Error: ${err.message}`);
      }
    }
  }
};

/**
 * Deploys an Apps Script project.
 * @param cmd.versionNumber {string} The project version to deploy at.
 * @param cmd.desc {string} The deployment description.
 * @param cmd.deploymentId  {string} The deployment ID to redeploy.
 */
export const deploy = async (cmd: { versionNumber: number; description: string; deploymentId: string }) => {
  await checkIfOnline();
  await loadAPICredentials();
  const { scriptId } = await getProjectSettings();
  if (!scriptId) return;
  spinner.setSpinnerTitle(LOG.DEPLOYMENT_START(scriptId)).start();
  let { versionNumber } = cmd;
  const { description = '', deploymentId } = cmd;

  // if no version, create a new version
  if (!versionNumber) {
    const version = await script.projects.versions.create({
      scriptId,
      requestBody: {
        description,
      },
    });
    spinner.stop(true);
    if (version.status !== 200) {
      return logError(null, ERROR.ONE_DEPLOYMENT_CREATE);
    }
    versionNumber = version.data.versionNumber || 0;
    console.log(LOG.VERSION_CREATED(versionNumber));
  }

  spinner.setSpinnerTitle(LOG.DEPLOYMENT_CREATE);
  let deployments;
  if (!deploymentId) {
    // if no deploymentId, create a new deployment
    deployments = await script.projects.deployments.create({
      scriptId,
      requestBody: {
        versionNumber,
        manifestFileName: PROJECT_MANIFEST_BASENAME,
        description,
      },
    });
  } else {
    // elseif, update deployment
    deployments = await script.projects.deployments.update({
      scriptId,
      deploymentId,
      requestBody: {
        deploymentConfig: {
          versionNumber,
          manifestFileName: PROJECT_MANIFEST_BASENAME,
          description,
        },
      },
    });
  }
  spinner.stop(true);
  if (deployments.status !== 200) {
    logError(null, ERROR.DEPLOYMENT_COUNT);
  } else {
    console.log(`- ${deployments.data.deploymentId} @${versionNumber}.`);
  }
};

/**
 * Removes a deployment from the Apps Script project.
 * @param deploymentId {string} The deployment's ID
 */
export const undeploy = async (deploymentId: string) => {
  await checkIfOnline();
  await loadAPICredentials();
  const { scriptId } = await getProjectSettings();
  if (!scriptId) return;
  if (!deploymentId) {
    const deploymentsList = await script.projects.deployments.list({
      scriptId,
    });
    if (deploymentsList.status !== 200) {
      return logError(deploymentsList.statusText);
    }
    const deployments = deploymentsList.data.deployments || [];
    if (!deployments.length) {
      logError(null, ERROR.SCRIPT_ID_INCORRECT(scriptId));
    }
    if (deployments.length <= 1) {
      // @HEAD (Read-only deployments) may not be deleted.
      logError(null, ERROR.NO_VERSIONED_DEPLOYMENTS);
    }
    deploymentId = deployments[deployments.length - 1].deploymentId || '';
  }
  spinner.setSpinnerTitle(LOG.UNDEPLOYMENT_START(deploymentId)).start();
  const deployment = await script.projects.deployments.delete({
    scriptId,
    deploymentId,
  });
  spinner.stop(true);
  if (deployment.status !== 200) {
    return logError(null, ERROR.READ_ONLY_DELETE);
  } else {
    console.log(LOG.UNDEPLOYMENT_FINISH(deploymentId));
  }
};

/**
 * Lists a user's Apps Script projects using Google Drive.
 */
export const list = async () => {
  await checkIfOnline();
  await loadAPICredentials();
  spinner.setSpinnerTitle(LOG.FINDING_SCRIPTS).start();
  const filesList = await drive.files.list({
    pageSize: 50,
    // fields isn't currently supported
    // https://github.com/googleapis/google-api-nodejs-client/issues/1374
    // fields: 'nextPageToken, files(id, name)',
    q: 'mimeType="application/vnd.google-apps.script"',
  });
  spinner.stop(true);
  if (filesList.status !== 200) {
    return logError(null, ERROR.DRIVE);
  }
  const files = filesList.data.files || [];
  if (files.length) {
    return console.log(LOG.FINDING_SCRIPTS_DNE);
  }
  const NAME_PAD_SIZE = 20;
  files.map((file: any) => {
    console.log(`${padEnd(ellipsize(file.name, NAME_PAD_SIZE), NAME_PAD_SIZE)} – ${URL.SCRIPT(file.id)}`);
  });
};

/**
 * Lists a script's deployments.
 */
export const deployments = async () => {
  await checkIfOnline();
  await loadAPICredentials();
  const { scriptId } = await getProjectSettings();
  if (!scriptId) return;
  spinner.setSpinnerTitle(LOG.DEPLOYMENT_LIST(scriptId)).start();
  const deployments = await script.projects.deployments.list({
    scriptId,
  });
  spinner.stop(true);
  if (deployments.status !== 200) {
    return logError(deployments.statusText);
  }
  const deploymentsList = deployments.data.deployments || [];
  const numDeployments = deploymentsList.length;
  const deploymentWord = pluralize('Deployment', numDeployments);
  console.log(`${numDeployments} ${deploymentWord}.`);
  deploymentsList.map(({ deploymentId, deploymentConfig }: any) => {
    const versionString = !!deploymentConfig.versionNumber ? `@${deploymentConfig.versionNumber}` : '@HEAD';
    const description = deploymentConfig.description ? '- ' + deploymentConfig.description : '';
    console.log(`- ${deploymentId} ${versionString} ${description}`);
  });
};

/**
 * Lists versions of an Apps Script project.
 */
export const versions = async () => {
  await checkIfOnline();
  await loadAPICredentials();
  spinner.setSpinnerTitle('Grabbing versions...').start();
  const { scriptId } = await getProjectSettings();
  const versions = await script.projects.versions.list({
    scriptId,
    pageSize: 500,
  });
  spinner.stop(true);
  if (versions.status !== 200) {
    return logError(versions.statusText);
  }
  const data = versions.data;
  if (!data || !data.versions || !data.versions.length) {
    return logError(null, LOG.DEPLOYMENT_DNE);
  }
  const numVersions = data.versions.length;
  console.log(LOG.VERSION_NUM(numVersions));
  data.versions.reverse().map((version: any) => {
    console.log(LOG.VERSION_DESCRIPTION(version));
  });
};

/**
 * Creates a new version of an Apps Script project.
 */
export const version = async (description: string) => {
  await checkIfOnline();
  await loadAPICredentials();
  const { scriptId } = await getProjectSettings();
  if (!description) {
    const answers = await prompt([
      {
        type: 'input',
        name: 'description',
        message: 'Give a description:',
        default: '',
      },
    ]);
    description = answers.description;
  }
  spinner.setSpinnerTitle(LOG.VERSION_CREATE).start();
  const versions = await script.projects.versions.create({
    scriptId,
    requestBody: {
      description,
    },
  });
  spinner.stop(true);
  if (versions.status !== 200) {
    return logError(versions.statusText);
  }
  console.log(LOG.VERSION_CREATED(versions.data.versionNumber || -1));
};

/**
 * Displays the status of which Apps Script files are ignored from .claspignore
 * @param cmd.json {boolean} Displays the status in json format.
 */
export const status = async (cmd: { json: boolean }) => {
  await checkIfOnline();
  await validateManifest();
  const { scriptId, rootDir } = await getProjectSettings();
  if (!scriptId) return;
  getProjectFiles(rootDir, (err, projectFiles) => {
    if (err) return console.log(err);
    if (projectFiles) {
      const [filesToPush, untrackedFiles] = projectFiles;
      if (cmd.json) {
        console.log(JSON.stringify({ filesToPush, untrackedFiles }));
      } else {
        console.log(LOG.STATUS_PUSH);
        filesToPush.forEach(file => console.log(`└─ ${file}`));
        console.log(); // Separate Ignored files list.
        console.log(LOG.STATUS_IGNORE);
        untrackedFiles.forEach(file => console.log(`└─ ${file}`));
      }
    }
  });
};

/**
 * Opens an Apps Script project's script.google.com editor.
 * @param scriptId {string} The Apps Script project to open.
 * @param cmd.open {boolean} If true, the command will open the webapps URL.
 */
export const openCmd = async (scriptId: any, cmd: { webapp: boolean }) => {
  await checkIfOnline();
  if (!scriptId) scriptId = (await getProjectSettings()).scriptId;
  if (scriptId.length < 30) {
    return logError(null, ERROR.SCRIPT_ID_INCORRECT(scriptId));
  }
  // If we're not a web app, open the script URL.
  if (!cmd.webapp) {
    console.log(LOG.OPEN_PROJECT(scriptId));
    return open(URL.SCRIPT(scriptId), { wait: false });
  }
  // Otherwise, open the latest deployment.
  await loadAPICredentials();
  const deploymentsList = await script.projects.deployments.list({
    scriptId,
  });
  if (deploymentsList.status !== 200) {
    return logError(deploymentsList.statusText);
  }
  const deployments = deploymentsList.data.deployments || [];
  if (!deployments.length) {
    logError(null, ERROR.SCRIPT_ID_INCORRECT(scriptId));
  }
  const choices = deployments
    .sort((d1: any, d2: any) => d1.updateTime.localeCompare(d2.updateTime))
    .map((deployment: any) => {
      const DESC_PAD_SIZE = 30;
      const id = deployment.deploymentId;
      const description = deployment.deploymentConfig.description;
      const versionNumber = deployment.deploymentConfig.versionNumber;
      return {
        name:
          padEnd(ellipsize(description || '', DESC_PAD_SIZE), DESC_PAD_SIZE) +
          `@${padEnd(versionNumber || 'HEAD', 4)} - ${id}`,
        value: deployment,
      };
    });
  const answers = await prompt([
    {
      type: 'list',
      name: 'deployment',
      message: 'Open which deployment?',
      choices,
    },
  ]);
  console.log(LOG.OPEN_WEBAPP(answers.deployment.deploymentId));
  open(getWebApplicationURL(answers.deployment), { wait: false });
};

/**
 * Acts as a router to apis subcommands
 * Calls functions for list, enable, or disable
 * Otherwise returns an error of command not supported
 */
export const apis = async () => {
  await loadAPICredentials();
  const subcommand: string = process.argv[3]; // clasp apis list => "list"
  const serviceName = process.argv[4]; // clasp apis enable drive => "drive"
  const getProjectIdAndServiceURL = async () => {
    if (!serviceName) {
      logError(null, 'An API name is required. Try sheets');
    }
    const serviceURL = `${serviceName}.googleapis.com`; // i.e. sheets.googleapis.com
    const projectId = await getProjectId(); // will prompt user to set up if required
    if (!projectId) throw logError(null, ERROR.NO_GCLOUD_PROJECT);
    return [projectId, serviceURL];
  };

  const enableOrDisableAPI = async (enable: boolean) => {
    const [projectId, serviceURL] = await getProjectIdAndServiceURL();
    const name = `projects/${projectId}/services/${serviceURL}`;
    try {
      if (enable) {
        await serviceUsage.services.enable({ name });
      } else {
        await serviceUsage.services.disable({ name });
      }
      await enableOrDisableAdvanceServiceInManifest(serviceName, enable);
      console.log(`${enable ? 'Enable' : 'Disable'}d ${serviceName}.`);
    } catch (e) {
      // If given non-existent API (like fakeAPI, it throws 403 permission denied)
      // We will log this for the user instead:
      console.log(e);
      logError(null, ERROR.NO_API(enable, serviceName));
    }
  };

  // The apis subcommands.
  const command: { [key: string]: Function } = {
    enable: async () => {
      enableOrDisableAPI(true);
    },
    disable: async () => {
      enableOrDisableAPI(false);
    },
    list: async () => {
      await checkIfOnline();
      /**
       * List currently enabled APIs.
       */
      console.log('\n# Currently enabled APIs:');
      const projectId = await getProjectId(); // will prompt user to set up if required
      const MAX_PAGE_SIZE = 200; // This is the max page size according to the docs.
      const list = await serviceUsage.services.list({
        parent: `projects/${projectId}`,
        filter: 'state:ENABLED',
        pageSize: MAX_PAGE_SIZE,
      });
      const serviceList = list.data.services || [];
      if (serviceList.length >= MAX_PAGE_SIZE) {
        console.log('Uh oh. It looks like Grant did not add pagination. Please create a bug.');
      }

      // Filter out the disabled ones. Print the enabled ones.
      const enabledAPIs = serviceList.filter(service => {
        return service.state === 'ENABLED';
      });
      for (const enabledAPI of enabledAPIs) {
        if (enabledAPI.config && enabledAPI.config.documentation) {
          const name = enabledAPI.config.name || 'Unknown name.';
          console.log(`${name.substr(0, name.indexOf('.'))} - ${enabledAPI.config.documentation.summary}`);
        }
      }

      /**
       * List available APIs.
       */
      console.log('\n# List of available APIs:');
      const { data } = await discovery.apis.list({
        preferred: true,
      });
      const services = data.items || [];
      // Only get the public service IDs
      const PUBLIC_ADVANCED_SERVICE_IDS = PUBLIC_ADVANCED_SERVICES.map(
        advancedService => advancedService.serviceId,
      );

      // Merge discovery data with public services data.
      const publicServices = [];
      for (const publicServiceId of PUBLIC_ADVANCED_SERVICE_IDS) {
        const service: any = services.find(s => s.name === publicServiceId);
        // for some reason 'youtubePartner' is not in the api list.
        if (service && service.id && service.description) {
          publicServices.push(service);
        }
      }

      // Sort the services based on id
      publicServices.sort((a: any, b: any) => {
        if (a.id < b.id) return -1;
        if (a.id > b.id) return 1;
        return 0;
      });

      // Format the list
      for (const api of publicServices) {
        console.log(`${padEnd(api.name, 25)} - ${padEnd(api.description, 60)}`);
      }
    },
    undefined: () => {
      command.list();

      console.log(`# Try these commands:
- clasp apis list
- clasp apis enable slides
- clasp apis disable slides`);
    },
  };
  if (command[subcommand]) {
    command[subcommand]();
  } else {
    logError(null, ERROR.COMMAND_DNE('apis ' + subcommand));
  }
};

/**
 * Gets or sets a setting in .clasp.json
 * @param {keyof ProjectSettings} settingKey The key to set
 * @param {string?} settingValue Optional value to set the key to
 */
export const setting = async (settingKey: keyof ProjectSettings, settingValue?: string) => {
  // Make a new spinner piped to stdErr so we don't interfere with output
  if (!settingValue) {
    // Display current values
    const currentSettings = await getProjectSettings();

    if (settingKey in currentSettings) {
      let keyValue = currentSettings[settingKey];
      if (Array.isArray(keyValue)) {
        keyValue = keyValue.toString();
      } else if (typeof keyValue !== 'string') {
        keyValue = '';
      }
      // We don't use console.log as it automatically adds a new line
      // Which interfers with storing the value
      process.stdout.write(keyValue);
    } else {
      logError(null, `Unknown key "${settingKey}"`);
    }
  } else {
    // Set specified key to the specified value
    if (settingKey !== 'scriptId' && settingKey !== 'rootDir') {
      logError(null, `Setting "${settingKey}" is unsupported`);
    }

    try {
      const currentSettings = await getProjectSettings();
      const currentValue = settingKey in currentSettings ? currentSettings[settingKey] : '';
      const scriptId = settingKey === 'scriptId' ? settingValue : currentSettings.scriptId;
      const rootDir = settingKey === 'rootDir' ? settingValue : currentSettings.rootDir;
      await saveProject(scriptId, rootDir);
      console.log(`\nUpdated "${settingKey}": "${currentValue}" -> "${settingValue}"`);
    } catch (e) {
      logError(null, 'Unable to update .clasp.json');
    }
  }
};
