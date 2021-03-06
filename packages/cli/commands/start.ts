import * as localtunnel from 'localtunnel';
import {
	TUNNEL_SUBDOMAIN_ENV,
	UserSettings,
} from "n8n-core";
import { Command, flags } from '@oclif/command';
const open = require('open');
import { promisify } from 'util';
import { dirname } from 'path';

import * as config from '../config';
import {
	ActiveWorkflowRunner,
	CredentialTypes,
	Db,
	GenericHelpers,
	LoadNodesAndCredentials,
	NodeTypes,
	Server,
	TestWebhooks,
} from "../src";

const tunnel = promisify(localtunnel);

// // Add support for internationalization
// const fullIcuPath = require.resolve('full-icu');
// process.env.NODE_ICU_DATA = dirname(fullIcuPath);

let activeWorkflowRunner: ActiveWorkflowRunner.ActiveWorkflowRunner | undefined;
let processExistCode = 0;


export class Start extends Command {
	static description = 'Starts n8n. Makes Web-UI available and starts active workflows';

	static examples = [
		`$ n8n start`,
		`$ n8n start --tunnel`,
		`$ n8n start -o`,
		`$ n8n start --tunnel -o`,
	];

	static flags = {
		help: flags.help({ char: 'h' }),
		open: flags.boolean({
			char: 'o',
			description: 'opens the UI automatically in browser',
		}),
		tunnel: flags.boolean({
			description: 'runs the webhooks via a hooks.n8n.cloud tunnel server. Use only for testing and development!',
		}),
	};


	/**
	 * Opens the UI in browser
	 */
	static openBrowser() {
		const editorUrl = GenericHelpers.getBaseUrl();

		open(editorUrl, { wait: true })
			.catch((error: Error) => {
				console.log(`\nWas not able to open URL in browser. Please open manually by visiting:\n${editorUrl}\n`);
			});
	}


	/**
	 * Stoppes the n8n in a graceful way.
	 * Make for example sure that all the webhooks from third party services
	 * get removed.
	 */
	static async stopProcess() {
		console.log(`\nStopping n8n...`);

		setTimeout(() => {
			// In case that something goes wrong with shutdown we
			// kill after max. 30 seconds no matter what
			process.exit(processExistCode);
		}, 30000);

		const removePromises = [];
		if (activeWorkflowRunner !== undefined) {
			removePromises.push(activeWorkflowRunner.removeAll());
		}

		// Remove all test webhooks
		const testWebhooks = TestWebhooks.getInstance();
		removePromises.push(testWebhooks.removeAll());

		await Promise.all(removePromises);

		process.exit(processExistCode);
	}


	async run() {
		// Make sure that n8n shuts down gracefully if possible
		process.on('SIGTERM', Start.stopProcess);
		process.on('SIGINT', Start.stopProcess);

		const { flags } = this.parse(Start);

		// Wrap that the process does not close but we can still use async
		(async () => {
			try {
				// Start directly with the init of the database to improve startup time
				const startDbInitPromise = Db.init();

				// Make sure the settings exist
				const userSettings = await UserSettings.prepareUserSettings();

				// Load all node and credential types
				const loadNodesAndCredentials = LoadNodesAndCredentials();
				await loadNodesAndCredentials.init();

				// Add the found types to an instance other parts of the application can use
				const nodeTypes = NodeTypes();
				await nodeTypes.init(loadNodesAndCredentials.nodeTypes);
				const credentialTypes = CredentialTypes();
				await credentialTypes.init(loadNodesAndCredentials.credentialTypes);

				// Wait till the database is ready
				await startDbInitPromise;

				if (flags.tunnel === true) {
					this.log('\nWaiting for tunnel ...');

					let tunnelSubdomain;
					if (process.env[TUNNEL_SUBDOMAIN_ENV] !== undefined && process.env[TUNNEL_SUBDOMAIN_ENV] !== '') {
						tunnelSubdomain = process.env[TUNNEL_SUBDOMAIN_ENV];
					} else if (userSettings.tunnelSubdomain !== undefined) {
						tunnelSubdomain = userSettings.tunnelSubdomain;
					}

					if (tunnelSubdomain === undefined) {
						// When no tunnel subdomain did exist yet create a new random one
						const availableCharacters = 'abcdefghijklmnopqrstuvwxyz0123456789';
						userSettings.tunnelSubdomain = Array.from({ length: 24 }).map(() => {
							return availableCharacters.charAt(Math.floor(Math.random() * availableCharacters.length));
						}).join('');

						await UserSettings.writeUserSettings(userSettings);
					}

					const tunnelSettings: localtunnel.TunnelConfig = {
						host: 'https://hooks.n8n.cloud',
						subdomain: tunnelSubdomain,
					};

					const port = config.get('port') as number;

					// @ts-ignore
					const webhookTunnel = await tunnel(port, tunnelSettings);

					process.env.WEBHOOK_TUNNEL_URL = webhookTunnel.url + '/';
					this.log(`Tunnel URL: ${process.env.WEBHOOK_TUNNEL_URL}\n`);
					this.log('IMPORTANT! Do not share with anybody as it would give people access to your n8n instance!');
				}

				await Server.start();

				// Start to get active workflows and run their triggers
				activeWorkflowRunner = ActiveWorkflowRunner.getInstance();
				await activeWorkflowRunner.init();

				const editorUrl = GenericHelpers.getBaseUrl();
				this.log(`\nEditor is now accessible via:\n${editorUrl}`);

				// Allow to open n8n editor by pressing "o"
				if (Boolean(process.stdout.isTTY) && process.stdin.setRawMode) {
					process.stdin.setRawMode(true);
					process.stdin.resume();
					process.stdin.setEncoding('utf8');
					let inputText = '';

					if (flags.open === true) {
						Start.openBrowser();
					}
					this.log(`\nPress "o" to open in Browser.`);
					process.stdin.on("data", (key) => {
						if (key === 'o') {
							Start.openBrowser();
							inputText = '';
						} else if (key.charCodeAt(0) === 3) {
							// Ctrl + c got pressed
							Start.stopProcess();
						} else {
							// When anything else got pressed, record it and send it on enter into the child process
							if (key.charCodeAt(0) === 13) {
								// send to child process and print in terminal
								process.stdout.write('\n');
								inputText = '';
							} else {
								// record it and write into terminal
								inputText += key;
								process.stdout.write(key);
							}
						}
					});
				}
			} catch (error) {
				this.error(`There was an error: ${error.message}`);

				processExistCode = 1;
				// @ts-ignore
				process.emit('SIGINT');
			}
		})();
	}
}
