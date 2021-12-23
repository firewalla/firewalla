import { Scalar } from '../../nodes/Scalar.js';

const nullTag = {
    identify: value => value == null,
    createNode: () => new Scalar(null),
    default: true,
    tag: 'tag:yaml.org,2002:null',
    test: /^(?:~|[Nn]ull|NULL)?$/,
    resolve: () => new Scalar(null),
    stringify: ({ source }, ctx) => source && nullTag.test.test(source) ? source : ctx.options.nullStr
};

export { nullTag };
