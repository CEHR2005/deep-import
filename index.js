import apolloClient from '@apollo/client';
const { gql } = apolloClient;
import {DeepClient} from "@deep-foundation/deeplinks/imports/client.js";
import {readFile} from "fs/promises";
import {generateApolloClient} from "@deep-foundation/hasura/client.js";
import axios from "axios";
import FormData from "form-data";
import fs from "fs";
function createApolloClient(uri, jwt) {
    const url = new URL(uri);
    let ssl;

    if (url.protocol === "https:") {
        ssl = true;
    } else if (url.protocol === "http:") {
        ssl = false;
    } else {
        throw new Error(`Unsupported protocol: ${url.protocol}`);
    }
    const path = url.hostname + url.pathname
    return generateApolloClient({
        path,
        ssl,
        token: jwt
    });
}
async function getMigrationsEndId(client) {
    const result = await client.query({
        query: gql`
            query Links {
                links(where: {type_id: {_eq: "182"}}) {
                    id
                }
            }
        `
    });
    return result.data.links[0].id;
}
async function getLastLinkId(client) {
    const result = await client.query({
        query: gql`
            query Links {
                links(order_by: { id: desc }, limit: 1) {
                    id
                }
            }
        `
    });
    return result.data.links[0].id;
}
function deleteLinksGreaterThanId(client, id) {
    client
    .mutate({
        mutation: gql`
            mutation DeleteLinks($id: bigint) {
                delete_links(where: { id: { _gt: $id } }) {
                    affected_rows
                }
            }
        `,
        variables: { id },
    })
    .then((result) => {
        console.log(`Deleted ${result.data.delete_links.affected_rows} rows`);
    })
    .catch((error) => console.error(error));
}

async function createDeepClient(url, jwt) {
    const apolloClient = createApolloClient(url, jwt)

    const unloginedDeep = new DeepClient({apolloClient});
    const guest = await unloginedDeep.guest();
    const guestDeep = new DeepClient({deep: unloginedDeep, ...guest});
    const admin = await guestDeep.login({
        linkId: await guestDeep.id('deep', 'admin'),
    });
    return new DeepClient({deep: guestDeep, ...admin})
}
export async function getLinksFromFile(filename) {
    const data = await readFile(`${filename}/${filename}.json`, 'utf8');
    return JSON.parse(data)
}

async function insertLinksFromFile(filename, gqlLink, jwt, linksData, diff=0, MigrationsEndId, overwrite, debug) {
    let deep = await createDeepClient(gqlLink, jwt);
    // let ids = linksData.map(link => link.id);
    // let minId = Math.min(ids);
    // let maxId = Math.max(ids);
    // let rangeToReserve = maxId - minId;

    const reservedIds = await deep.reserve(linksData.length);
    const idsMap = {};
    for (const link in linksData) {
        idsMap[link.id] = reservedIds.pop();
    }

    const ssl = deep.apolloClient.ssl;
    const path = deep.apolloClient.path.slice(0, -4);
    try {
        let links = [];
        let objects = [];
        let numbers = [];
        let strings = [];
        let files = [];

        for (let i = 1; i < linksData.length; i++) {
            const link = linksData[i];
            // if (!overwrite && diff !== 0) {
            //     if (link.id > MigrationsEndId) {
            //         link.id += diff
            //     }
            //     if (link.from_id > MigrationsEndId) {
            //         link.from_id += diff
            //     }
            //     if (link.to_id > MigrationsEndId) {
            //         link.to_id += diff
            //     }
            //     if (link.type_id > MigrationsEndId) {
            //         link.type_id += diff
            //     }
            // }

            console.log('before', link);

            if (idsMap[link.id]) {
                link.id = idsMap[link.id];
            }
            if (idsMap[link.type_id]) {
                link.type_id = idsMap[link.type_id];
            }
            if (idsMap[link.from_id]) {
                link.from_id = idsMap[link.from_id];
            }
            if (idsMap[link.to_id]) {
                link.to_id = idsMap[link.to_id];
            }

            console.log('after', link);

            if (link.file){
                files.push(link)
            }
            links.push({
                id: link.id,
                from_id: link.from_id,
                to_id: link.to_id,
                type_id: link.type_id
            });

            if (link.string) {
                link.string.link_id = link.id
                strings.push(link.string);
            }

            if (link.number) {
                link.number.link_id = link.id
                numbers.push(link.number);
            }

            if (link.object) {
                link.object.link_id = link.id
                objects.push(link.object);
            }
            if (debug){
                const response = await deep.serial({
                    operations: [
                        {
                            table: 'links',
                            type: 'insert',
                            objects: links
                        },
                        {
                            table: 'objects',
                            type: 'insert',
                            objects: objects
                        },
                        {
                            table: 'numbers',
                            type: 'insert',
                            objects: numbers
                        },
                        {
                            table: 'strings',
                            type: 'insert',
                            objects: strings
                        }
                    ]
                });
                console.log(
                    JSON.stringify({
                        request: {
                            link: links,
                            string: strings,
                            number: numbers,
                            object: objects,
                            files: files
                        },
                        response: response
                    }, null, 2)
                )
                for (let link of files) {
                    let savedfilename = link.file.name
                    const extension = savedfilename.split('.').pop();
                    let formData = new FormData();
                    formData.append('file', fs.createReadStream(`${filename}/${link.id}.${extension}`));
                    await axios.post(`http${ssl ? "s" : ""}://${path}/file`, formData, {
                        headers: {
                            'linkId': link.id,
                            "Authorization": `Bearer ${deep.token}`,
                        },
                    })
                }
                links = [];
                objects = [];
                numbers = [];
                strings = [];
                files = [];
            }
        }

        if (!debug){
            await deep.serial({
                operations: [
                    {
                        table: 'links',
                        type: 'insert',
                        objects: links
                    },
                    {
                        table: 'objects',
                        type: 'insert',
                        objects: objects
                    },
                    {
                        table: 'numbers',
                        type: 'insert',
                        objects: numbers
                    },
                    {
                        table: 'strings',
                        type: 'insert',
                        objects: strings
                    }
                ]
            });
            for (let link of files) {
                let savedfilename = link.file.name
                const extension = savedfilename.split('.').pop();
                let formData = new FormData();
                formData.append('file', fs.createReadStream(`${filename}/${link.id}.${extension}`));
                await axios.post(`http${ssl ? "s" : ""}://${path}/file`, formData, {
                    headers: {
                        'linkId': link.id,
                        "Authorization": `Bearer ${deep.token}`,
                    },
                })
            }
        }
        console.log('Data inserted successfully');
    } catch (error) {
        console.error(error);
    }
}
export async function importData(url, jwt, filename, overwrite, debug) {
    console.log('test');

    const client = createApolloClient(url, jwt)
    const MigrationsEndId = await getMigrationsEndId(client)
    const lastLinkId = await getLastLinkId(client)
    let linksData = await getLinksFromFile(filename)
    const SaveMigrationsEndId = linksData[0]["id"]

    if (MigrationsEndId === SaveMigrationsEndId) {
        if (overwrite) {
            deleteLinksGreaterThanId(client, MigrationsEndId)
            await insertLinksFromFile(filename, url, jwt,linksData, 0, 0, false, debug);
        } else {
            let diff = lastLinkId - MigrationsEndId
            await insertLinksFromFile(filename, url, jwt, linksData, diff, MigrationsEndId, overwrite, debug)
        }
    }
    else {
        throw new Error("MigrationsEndId is different from MigrationsEndId in Save")
    }
}
