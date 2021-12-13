'use strict';

var Node = require('../nodes/Node.js');
var stringify = require('./stringify.js');
var stringifyComment = require('./stringifyComment.js');

function stringifyDocument(doc, options) {
    const lines = [];
    let hasDirectives = options.directives === true;
    if (options.directives !== false) {
        const dir = doc.directives.toString(doc);
        if (dir) {
            lines.push(dir);
            hasDirectives = true;
        }
        else if (doc.directives.marker)
            hasDirectives = true;
    }
    if (hasDirectives)
        lines.push('---');
    if (doc.commentBefore) {
        if (lines.length !== 1)
            lines.unshift('');
        lines.unshift(stringifyComment.stringifyComment(doc.commentBefore, ''));
    }
    const ctx = stringify.createStringifyContext(doc, options);
    let chompKeep = false;
    let contentComment = null;
    if (doc.contents) {
        if (Node.isNode(doc.contents)) {
            if (doc.contents.spaceBefore && hasDirectives)
                lines.push('');
            if (doc.contents.commentBefore)
                lines.push(stringifyComment.stringifyComment(doc.contents.commentBefore, ''));
            // top-level block scalars need to be indented if followed by a comment
            ctx.forceBlockIndent = !!doc.comment;
            contentComment = doc.contents.comment;
        }
        const onChompKeep = contentComment ? undefined : () => (chompKeep = true);
        let body = stringify.stringify(doc.contents, ctx, () => (contentComment = null), onChompKeep);
        if (contentComment)
            body = stringifyComment.addComment(body, '', contentComment);
        if ((body[0] === '|' || body[0] === '>') &&
            lines[lines.length - 1] === '---') {
            // Top-level block scalars with a preceding doc marker ought to use the
            // same line for their header.
            lines[lines.length - 1] = `--- ${body}`;
        }
        else
            lines.push(body);
    }
    else {
        lines.push(stringify.stringify(doc.contents, ctx));
    }
    let dc = doc.comment;
    if (dc && chompKeep)
        dc = dc.replace(/^\n+/, '');
    if (dc) {
        if ((!chompKeep || contentComment) && lines[lines.length - 1] !== '')
            lines.push('');
        lines.push(stringifyComment.stringifyComment(dc, ''));
    }
    return lines.join('\n') + '\n';
}

exports.stringifyDocument = stringifyDocument;
