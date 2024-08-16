import { Octokit } from "@octokit/rest";
import { throttling } from "@octokit/plugin-throttling";
import { retry } from "@octokit/plugin-retry";
import YAML from 'yaml'
import * as fs from "fs";
import { exit } from "process";
import semver, { clean } from 'semver';

function exitWithError(errorMessage) {
    console.error(errorMessage);
    exit(1);
}

if (!process.env.GITHUB_TOKEN) {
    exitWithError("set your GITHUB_TOKEN bud, go make a PAT with repo write access https://github.com/settings/tokens?type=beta")
}

let octokit = undefined;
if (!lintMode) {
    Octokit.plugin(throttling);
    Octokit.plugin(retry);
    octokit = new Octokit({
        auth: process.env.GITHUB_TOKEN,
        userAgent: "OpenGOAL-Mods/jakmods.dev",
        log: {
            debug: () => { },
            info: () => { },
            warn: console.warn,
            error: console.error,
        },
        throttle: {
            onRateLimit: (retryAfter, options) => {
                octokit.log.warn(
                    `Request quota exhausted for request ${options.method} ${options.url}`,
                );
                if (options.request.retryCount <= 2) {
                    console.log(`Retrying after ${retryAfter} seconds!`);
                    return true;
                }
            },
            onAbuseLimit: (retryAfter, options) => {
                octokit.log.warn(
                    `Abuse detected for request ${options.method} ${options.url}`,
                );
            },
        },
    });
}

// Retrieve the configuration so we know what to look for
if (!fs.existsSync("./config.yaml")) {
    exitWithError("Couldn't locate 'config.yaml' file, aborting!");
}

// Parse it
let configFile;
try {
    configFile = YAML.parse(fs.readFileSync("./config.yaml").toString())
} catch (e) {
    exitWithError(`Couldn't successfully parse config file, fix it!: ${e}`);
}

// Validate config file metadata
if (!configFile["metadata"]["name"]) {
    exitWithError(`'metadata' section missing schema_version or name`);
}

let modSourceData = {
    schemaVersion: "1.0.0",
    sourceName: configFile["metadata"]["name"],
    mods: {},
    texturePacks: {}
}

// Now we can start generating the actual mod-source file
if (!configFile["mods"]) {
    exitWithError(`'mods' section missing`);
}
// iterate through all listed repos and build up the file
for (const [modName, modInfo] of Object.entries(configFile["mods"])) {
    // Iterate through the releases
    // - check that we shouldn't ignore it
    // - if the assets have a `metadata.json` file, we download and inspect it for a handful of settings (potentially used more in the future)
    if (!validateJsonKeys(["display_name", "description", "authors", "tags", "supported_games"], Object.keys(modInfo), `${modName}`)) {
        exitWithError("aborting");
    }
    let modSourceInfo = {
        displayName: modInfo["display_name"],
        description: modInfo["description"],
        authors: modInfo["authors"],
        tags: modInfo["tags"],
        supportedGames: modInfo["supported_games"],
        websiteUrl: modInfo["website_url"],
        versions: [],
        coverArtUrl: undefined,
        thumbnailArtUrl: undefined,
        perGameConfig: null,
        externalLink: null
    };
    if (!Object.keys(modInfo).includes("website_url")) {
        // either its an external link and we can ignore it
        // or we infer it from the repo_owner_name
        if (!Object.keys(modInfo).includes("external_link")) {
            modSourceInfo.websiteUrl = `https://www.github.com/${modInfo["repo_owner"]}/${modInfo["repo_name"]}`;
        }
    }
    if (Object.keys(modInfo).includes("cover_art_url")) {
        modSourceInfo.coverArtUrl = modInfo["cover_art_url"];
    }
    if (Object.keys(modInfo).includes("thumbnail_art_url")) {
        modSourceInfo.thumbnailArtUrl = modInfo["thumbnail_art_url"];
    }
    if (Object.keys(modInfo).includes("per_game_config")) {
        modSourceInfo.perGameConfig = {};
        // iterate per-game configs
        for (const [game, perGameConfig] of Object.entries(modInfo["per_game_config"])) {
            modSourceInfo.perGameConfig[game] = {};
            if (Object.keys(perGameConfig).includes("cover_art_url")) {
                modSourceInfo.perGameConfig[game].coverArtUrl = perGameConfig["cover_art_url"];
            }
            if (Object.keys(perGameConfig).includes("thumbnail_art_url")) {
                modSourceInfo.perGameConfig[game].thumbnailArtUrl = perGameConfig["thumbnail_art_url"];
            }
        }
    }
    // lint the per-game-config
    if (modSourceInfo.coverArtUrl === undefined) {
        if (!Object.keys(modInfo).includes("per_game_config")) {
            exitWithError(`${modName} does not define 'cover_art_url' but lacks 'per_game_config'`)
        }
        // Check per game config
        for (const supportedGame of modSourceInfo.supportedGames) {
            if (!Object.keys(modSourceInfo.perGameConfig).includes(supportedGame) || !Object.keys(modSourceInfo.perGameConfig[supportedGame]).includes("coverArtUrl")) {
                exitWithError(`${modName} does not define 'cover_art_url' and it's missing in 'per_game_config.${supportedGame}'`);
            }
        }
    }
    if (modSourceInfo.thumbnailArtUrl === undefined) {
        if (!Object.keys(modInfo).includes("per_game_config")) {
            exitWithError(`${modName} does not define 'thumbnail_art_url' but lacks 'per_game_config'`)
        }
        // Check per game config
        for (const supportedGame of modSourceInfo.supportedGames) {
            if (!Object.keys(modSourceInfo.perGameConfig).includes(supportedGame) || !Object.keys(modSourceInfo.perGameConfig[supportedGame]).includes("thumbnailArtUrl")) {
                exitWithError(`${modName} does not define 'thumbnail_art_url' and it's missing in 'per_game_config.${supportedGame}'`);
            }
        }
    }

    // if the mod is external only, we don't check releases
    if (Object.keys(modInfo).includes("external_link")) {
        modSourceInfo.externalLink = modInfo["external_link"];
        modSourceData.mods[modName] = modSourceInfo;
        continue;
    }
    // otherwise, we poll github
    if (!modInfo["repo_owner"] || !modInfo["repo_name"]) {
        exitWithError(`'repo_owner' or 'repo_name' missing in: ${modName}`);
    }
    if (!lintMode) {
        const modReleases = await octokit.paginate(octokit.rest.repos.listReleases, { owner: modInfo["repo_owner"], repo: modInfo["repo_name"] });
        for (const release of modReleases) {
            let cleaned_release_tag = release.tag_name;
            if (cleaned_release_tag.startsWith("v")) {
                cleaned_release_tag = cleaned_release_tag.substring(1);
            }
            if (!semver.valid(cleaned_release_tag)) {
                console.error(`${modName}:${cleaned_release_tag} is not a valid semantic version, skipping`);
                continue;
            }
            // Check that we shouldn't ignore it
            if (Object.keys(modInfo).includes("ignore_versions")) {
                let skipIt = false;
                for (const ignore_version of modInfo["ignore_versions"]) {
                    if (ignore_version.startsWith("<")) {
                        let cleaned_ignore_version = ignore_version.substring(1);
                        if (semver.lt(cleaned_release_tag, cleaned_ignore_version)) {
                            console.log(`ignoring release - ${modName}:${cleaned_release_tag}`);
                            skipIt = true;
                            break;
                        }
                    } else if (semver.eq(ignore_version, cleaned_release_tag)) {
                        console.log(`ignoring release - ${modName}:${ignore_version}`);
                        skipIt = true;
                        break;
                    }
                }
                if (skipIt) {
                    continue;
                }
                // otherwise, we ain't skipping it...yet
                let newVersion = {
                    version: cleaned_release_tag,
                    publishedDate: release.published_at,
                    settings: {
                        decompConfigOverride: "",
                        shareVanillaSaves: false,
                    },
                    assets: {
                        windows: null,
                        linux: null,
                        macos: null
                    }
                }
                // get the assets
                let metadataFileUrl = null;
                let metadataFileAssetId = null;
                for (const asset of release.assets) {
                    if (asset.name.toLowerCase().startsWith("windows-")) {
                        newVersion.assets.windows = asset.browser_download_url;
                    } else if (asset.name.toLowerCase().startsWith("linux-")) {
                        newVersion.assets.linux = asset.browser_download_url;
                    } else if (asset.name.toLowerCase().startsWith("macos-")) {
                        newVersion.assets.macos = asset.browser_download_url;
                    } else if (asset.name.toLowerCase() === "metadata.json") {
                        metadataFileUrl = asset.browser_download_url;
                        metadataFileAssetId = asset.id;
                    }
                }
                if (metadataFileUrl !== null) {
                    const metadataResp = await fetch(metadataFileUrl);
                    if (metadataResp.status === 200) {
                        try {
                            const data = JSON.parse(await metadataResp.text());
                            if (Object.keys(data).includes("settings")) {
                                newVersion.settings = data.settings;
                            }
                            // FIX HERE
                            // - update the `metadata.json` stuff using the info in the `config.yaml`
                            data.name = modSourceInfo.displayName;
                            data.description = modSourceInfo.description;
                            data.supportedGames = modSourceInfo.supportedGames;
                            data.authors = modSourceInfo.authors;
                            data.tags = modSourceInfo.tags;
                            data.websiteUrl = modSourceInfo.websiteUrl;
                            // - delete current asset
                            octokit.rest.repos.deleteReleaseAsset({
                                owner: modInfo["repo_owner"],
                                repo: modInfo["repo_name"],
                                asset_id: metadataFileAssetId
                            });
                            // - upload the modified data
                            const jsonString = JSON.stringify(data);
                            const jsonBuffer = Buffer.from(jsonString);
                            octokit.rest.repos.uploadReleaseAsset({
                                owner: modInfo["repo_owner"],
                                repo: modInfo["repo_name"],
                                release_id: release.id,
                                name: "metadata.json",
                                data: jsonBuffer
                            });
                        } catch (e) {
                            exitWithError(`Bad metadata.json, not valid JSON: ${e} -- ${modName}:${cleaned_release_tag}`)
                        }
                    } else {
                        exitWithError(`Hit non-200 status code when fetching metadata file for mod release version ${modName}:${cleaned_release_tag}`);
                    }
                } else {
                    try {
                        const data = {
                            schemaVersion: "0.1.0",
                            version: cleaned_release_tag,
                            name: modSourceInfo.displayName,
                            description: modSourceInfo.description,
                            supportedGames: modSourceInfo.supportedGames,
                            authors: modSourceInfo.authors,
                            tags: modSourceInfo.tags,
                            websiteUrl: modSourceInfo.websiteUrl,
                            publishedDate: release.published_at,
                            websiteUrl: `https://www.github.com/${modInfo["repo_owner"]}/${modInfo["repo_name"]}`
                        };
                        // - upload the modified data
                        const jsonString = JSON.stringify(data);
                        const jsonBuffer = Buffer.from(jsonString);
                        octokit.rest.repos.uploadReleaseAsset({
                            owner: modInfo["repo_owner"],
                            repo: modInfo["repo_name"],
                            release_id: release.id,
                            name: "metadata.json",
                            data: jsonBuffer
                        });
                    } catch (e) {
                        exitWithError(`couldn't upload new metadata.json, wtf: ${e} -- ${modName}:${cleaned_release_tag}`)
                    }
                }

                // If there are no assets, skip it -- there's nothing to download!
                if (newVersion.assets.windows === null && newVersion.assets.linux === null && newVersion.assets.macos === null) {
                    console.log(`ignoring version, no assets found - ${modName}:${cleaned_release_tag}`);
                    continue;
                }
                // otherwise, add it to the list
                modSourceInfo.versions.push(newVersion);
            }
        }
    }

    // add to source json
    modSourceData.mods[modName] = modSourceInfo;
}