'use strict';

const stringifyComment = (comment, indent) => /^\n+$/.test(comment)
    ? comment.substring(1)
    : comment.replace(/^(?!$)(?: $)?/gm, `${indent}#`);
function addComment(str, indent, comment) {
    return !comment
        ? str
        : comment.includes('\n')
            ? `${str}\n` + stringifyComment(comment, indent)
            : str.endsWith(' ')
                ? `${str}#${comment}`
                : `${str} #${comment}`;
}

exports.addComment = addComment;
exports.stringifyComment = stringifyComment;
