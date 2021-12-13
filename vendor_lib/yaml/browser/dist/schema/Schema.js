import { MAP, SCALAR, SEQ } from '../nodes/Node.js';
import { map } from './common/map.js';
import { seq } from './common/seq.js';
import { string } from './common/string.js';
import { coreKnownTags, getTags } from './tags.js';

const sortMapEntriesByKey = (a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
class Schema {
    constructor({ customTags, merge, resolveKnownTags, schema, sortMapEntries }) {
        this.merge = !!merge;
        this.name = schema || 'core';
        this.knownTags = resolveKnownTags ? coreKnownTags : {};
        this.tags = getTags(customTags, this.name);
        Object.defineProperty(this, MAP, { value: map });
        Object.defineProperty(this, SCALAR, { value: string });
        Object.defineProperty(this, SEQ, { value: seq });
        // Used by createMap()
        this.sortMapEntries =
            sortMapEntries === true ? sortMapEntriesByKey : sortMapEntries || null;
    }
    clone() {
        const copy = Object.create(Schema.prototype, Object.getOwnPropertyDescriptors(this));
        copy.tags = this.tags.slice();
        return copy;
    }
}

export { Schema };
