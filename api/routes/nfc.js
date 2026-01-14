/*    Copyright 2016-2025 Firewalla Inc.
 *
 *    This program is free software: you can redistribute it and/or  modify
 *    it under the terms of the GNU Affero General Public License, version 3,
 *    as published by the Free Software Foundation.
 *
 *    This program is distributed in the hope that it will be useful,
 *    but WITHOUT ANY WARRANTY; without even the implied warranty of
 *    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *    GNU Affero General Public License for more details.
 *
 *    You should have received a copy of the GNU Affero General Public License
 *    along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

'use strict';

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const http = require('http');
const log = require("../../net2/logger.js")(__filename, "info");

function validateNfcParameters(query) {
    /**
     * Validate NFC request parameters
     * @param {Object} query - Request query parameters
     * @returns {Object} - { success: boolean, data?: object, error?: string, statusCode?: number }
     */
    const rule = query.rule;
    const a = query.a;

    if (!rule || rule.trim() === '') {
        return {
            success: false,
            error: 'rule parameter is required',
            statusCode: 400
        };
    }

    // Set default action if not provided or empty
    if (!a || a.trim() === '') {
        a = 'pause';
    }

    // Validate action is either 'pause' or 'resume'
    const validActions = ['pause', 'resume'];
    if (!validActions.includes(a.trim())) {
        return {
            success: false,
            error: 'a parameter must be either "pause" or "resume"',
            statusCode: 400
        };
    }

    // Set default duration if not provided or empty
    const t = (query.t && query.t.trim() !== '') ? query.t : '1800';

    return {
        success: true,
        data: {
            gid: query.gid || '',
            rule: rule.trim(),
            a: a,  // Already trimmed above
            t: t
        }
    };
}

function fetchPolicy(pid) {
    /**
     * Fetch policy information via HTTP API
     * @param {string} pid - Policy ID
     * @returns {Promise<Object>} - Policy data or null
     */
    return new Promise((resolve, reject) => {
        const postData = JSON.stringify({ pid: pid });
        const url = 'http://127.0.0.1:8834/v1/encipher/simple?command=get&item=policy';

        const parsedUrl = new URL(url);
        const options = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port,
            path: parsedUrl.pathname + parsedUrl.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            }
        };

        const req = http.request(options, (res) => {
            let data = '';

            res.on('data', (chunk) => {
                data += chunk;
            });

            res.on('end', () => {
                try {
                    const response = JSON.parse(data);
                    if (response && response.data) {
                        resolve(response.data);
                    } else {
                        resolve(null);
                    }
                } catch (error) {
                    resolve(null);
                }
            });
        });

        req.on('error', (error) => {
            resolve(null);
        });

        req.write(postData);
        req.end();
    });
}

function fetchTag(tagId) {
    /**
     * Fetch tag information via HTTP API
     * @param {string} tagId - Tag ID to fetch
     * @returns {Promise<Object>} - Tag data with name and userTags or null
     */
    return new Promise((resolve, reject) => {
        const postData = JSON.stringify({ target: tagId });
        const url = 'http://127.0.0.1:8834/v1/encipher/simple?command=get&item=tag';

        const parsedUrl = new URL(url);
        const options = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port,
            path: parsedUrl.pathname + parsedUrl.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            }
        };

        const req = http.request(options, (res) => {
            let data = '';

            res.on('data', (chunk) => {
                data += chunk;
            });

            res.on('end', () => {
                try {
                    const response = JSON.parse(data);
                    if (response && response.data) {
                        resolve({
                            name: response.data.name || 'Unknown Tag',
                            userTags: response.data.policy?.userTags || []
                        });
                    } else {
                        resolve(null);
                    }
                } catch (error) {
                    resolve(null);
                }
            });
        });

        req.on('error', (error) => {
            resolve(null);
        });

        req.write(postData);
        req.end();
    });
}

function createNfcRequest(requestBody) {
    /**
     * Create NFC request via HTTP API
     * @param {Object} requestBody - Request body containing pid, action, duration, device, ip
     * @returns {Promise<Object>} - Response data or null
     */
    return new Promise((resolve, reject) => {
        const postData = JSON.stringify(requestBody);
        const url = 'http://127.0.0.1:8834/v1/encipher/simple?command=cmd&item=nfc:createRequest';

        const parsedUrl = new URL(url);
        const options = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port,
            path: parsedUrl.pathname + parsedUrl.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            }
        };

        const req = http.request(options, (res) => {
            let data = '';

            res.on('data', (chunk) => {
                data += chunk;
            });

            res.on('end', () => {
                try {
                    const response = JSON.parse(data);
                    if (response) {
                        resolve(response);
                    } else {
                        resolve(null);
                    }
                } catch (error) {
                    resolve(null);
                }
            });
        });

        req.on('error', (error) => {
            resolve(null);
        });

        req.write(postData);
        req.end();
    });
}

// Load HTML template
const TEMPLATE_PATH = path.join(__dirname, '../public/nfc/template.html');
let _htmlTemplate = null;

function loadHtmlTemplate() {
    if (_htmlTemplate === null) {
        try {
            _htmlTemplate = fs.readFileSync(TEMPLATE_PATH, 'utf8');
        } catch (error) {
            log.error(`Template file not found: ${TEMPLATE_PATH}`);
            throw error;
        }
    }
    return _htmlTemplate;
}

async function generatePolicyMessage(policy, action, duration) {
    /**
     * Generate a user-friendly policy message for NFC requests.
     */
    if (!policy) {
        return 'Policy not found';
    }

    // Fetch tag information if tag ID is available
    let userTag = 'Unknown User';
    if (policy.tag) {
        try {
            const tagData = await fetchTag(policy.tag);
            if (tagData && tagData.name) {
                userTag = tagData.name;
            }
        } catch (error) {
            // Keep default userTag if fetch fails
        }
    }

    const appName = policy.app_name || 'Unknown Site';
    const durationMinutes = duration ? Math.ceil(parseInt(duration) / 60) : 0;
    const durationText = durationMinutes > 0 ? ` for ${durationMinutes} minutes` : '';

    return `User ${userTag} is requesting access to ${appName}${durationText}.`;
}

// Main NFC page
// Path: /nfc?gid=test123&rule=143&a=pause&t=3600
router.get('/', async (req, res) => {
    try {
        // Validate required parameters
        const validation = validateNfcParameters(req.query);
        if (!validation.success) {
            return res.status(validation.statusCode).send(`Bad Request: ${validation.error}`);
        }
        const { gid, rule, a, t } = validation.data;

        let html = loadHtmlTemplate();

        // Map parameters: rule -> pid, a -> action, t -> duration
        const pid = rule;
        const action = a;
        const duration = t;

        // Generate policy message
        let policyMessage = '';
        if (pid) {
            try {
                const policy = await fetchPolicy(pid);
                policyMessage = generatePolicyMessage(policy, action, duration);
            } catch (error) {
                policyMessage = `Unable to load policy information for PID: ${pid}`;
            }
        }

        // Replace template variables
        html = html.replace(/__POLICY_MESSAGE__/g, policyMessage);
        html = html.replace(/__SUCCESS_CLASS__/g, '');
        html = html.replace(/__SUCCESS_PAGE__/g, '');

        res.send(html);
    } catch (error) {
        log.error('Error serving NFC page:', error);
        res.status(500).send('Internal Server Error');
    }
});

// Create NFC request page
router.get('/create', async (req, res) => {
    try {
        // Validate required parameters first
        const validation = validateNfcParameters(req.query);
        if (!validation.success) {
            return res.status(validation.statusCode).send(`Bad Request: ${validation.error}`);
        }
        const { gid, rule, a, t } = validation.data;

        // Map parameters: rule -> pid, a -> action, t -> duration
        const pid = rule;
        const action = a;
        const duration = t;

        // Generate policy message (needed for all page types)
        let policyMessage = '';
        if (pid) {
            try {
                const policy = await fetchPolicy(pid);
                policyMessage = await generatePolicyMessage(policy, action, duration);
            } catch (error) {
                policyMessage = `Unable to read the information`;
            }
        }

        // Check if this is a success page (sent=true)
        const isSuccessPage = req.query.sent === 'true';
        if (isSuccessPage) {
            // Return success page using template
            let html = loadHtmlTemplate();
            html = html.replace(/__CONTAINER_CLASS__/g, '');
            html = html.replace(/__POLICY_MESSAGE__/g, policyMessage);
            html = html.replace(/__SUCCESS_MESSAGE_CLASS__/g, 'show');
            return res.send(html);
        }

        // Handle the actual NFC request creation when send is not set
        if (!pid) {
            return res.status(400).json({ error: 'Policy ID (rule) is required' });
        }

        try {
            const result = await createNfcRequest({
                pid: pid,
                action: action,
                duration: duration ? parseInt(duration) : undefined,
                device: req.get('User-Agent') || 'Unknown Device',
                ip: req.ip || ''
            });

            // Redirect to same URL with sent=true to show success page
            const redirectUrl = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
            const finalUrl = redirectUrl + (redirectUrl.includes('?') ? '&' : '?') + 'sent=true';
            return res.redirect(finalUrl);
        } catch (error) {
            log.error('Failed to create NFC request:', error);
            return res.status(500).json({
                error: 'Failed to create NFC request',
                details: error.message
            });
        }

        // Regular page display (not sending request)
        let html = loadHtmlTemplate();

        // Replace template variables
        html = html.replace(/__CONTAINER_CLASS__/g, '');
        html = html.replace(/__POLICY_MESSAGE__/g, policyMessage);
        html = html.replace(/__SUCCESS_MESSAGE_CLASS__/g, '');

        res.send(html);
    } catch (error) {
        log.error('Error serving NFC create page:', error);
        res.status(500).send('Internal Server Error');
    }
});

// Health check
router.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

module.exports = router;