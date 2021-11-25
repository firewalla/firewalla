'use strict';

var Alias = require('../nodes/Alias.js');
var Node = require('../nodes/Node.js');
var Scalar = require('../nodes/Scalar.js');

const defaultTagPrefix = 'tag:yaml.org,2002:';
function findTagObject(value, tagName, tags) {
    if (tagName) {
        const match = tags.filter(t => t.tag === tagName);
        const tagObj = match.find(t => !t.format) || match[0];
        if (!tagObj)
            throw new Error(`Tag ${tagName} not found`);
        return tagObj;
    }
    return tags.find(t => t.identify && t.identify(value) && !t.format);
}
function createNode(value, tagName, ctx) {
    var _a, _b;
    if (Node.isDocument(value))
        value = value.contents;
    if (Node.isNode(value))
        return value;
    if (Node.isPair(value)) {
        const map = (_b = (_a = ctx.schema[Node.MAP]).createNode) === null || _b === void 0 ? void 0 : _b.call(_a, ctx.schema, null, ctx);
        map.items.push(value);
        return map;
    }
    if (value instanceof String ||
        value instanceof Number ||
        value instanceof Boolean ||
        (typeof BigInt === 'function' && value instanceof BigInt) // not supported everywhere
    ) {
        // https://tc39.es/ecma262/#sec-serializejsonproperty
        value = value.valueOf();
    }
    const { aliasDuplicateObjects, onAnchor, onTagObj, schema, sourceObjects } = ctx;
    // Detect duplicate references to the same object & use Alias nodes for all
    // after first. The `ref` wrapper allows for circular references to resolve.
    let ref = undefined;
    if (aliasDuplicateObjects && value && typeof value === 'object') {
        ref = sourceObjects.get(value);
        if (ref) {
            if (!ref.anchor)
                ref.anchor = onAnchor(value);
            return new Alias.Alias(ref.anchor);
        }
        else {
            ref = { anchor: null, node: null };
            sourceObjects.set(value, ref);
        }
    }
    if (tagName && tagName.startsWith('!!'))
        tagName = defaultTagPrefix + tagName.slice(2);
    let tagObj = findTagObject(value, tagName, schema.tags);
    if (!tagObj) {
        if (value && typeof value.toJSON === 'function')
            value = value.toJSON();
        if (!value || typeof value !== 'object') {
            const node = new Scalar.Scalar(value);
            if (ref)
                ref.node = node;
            return node;
        }
        tagObj =
            value instanceof Map
                ? schema[Node.MAP]
                : Symbol.iterator in Object(value)
                    ? schema[Node.SEQ]
                    : schema[Node.MAP];
    }
    if (onTagObj) {
        onTagObj(tagObj);
        delete ctx.onTagObj;
    }
    const node = (tagObj === null || tagObj === void 0 ? void 0 : tagObj.createNode)
        ? tagObj.createNode(ctx.schema, value, ctx)
        : new Scalar.Scalar(value);
    if (tagName)
        node.tag = tagName;
    if (ref)
        ref.node = node;
    return node;
}

exports.createNode = createNode;
