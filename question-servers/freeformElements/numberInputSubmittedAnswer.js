const _ = require('lodash');
const elementHelper = require('../../lib/element-helper');

module.exports = {};

module.exports.prepare = function($, element, variant_seed, block_index, question_data, callback) {
    callback(null);
};

module.exports.render = function($, element, block_index, question_data, callback) {
    try {
        const name = elementHelper.getAttrib(element, 'name');

        if (!question_data.params[name]) return callback(null, 'No params for ' + name);
        const params = question_data.params[name];

        if (!question_data.submitted_answer[name]) {
            return callback(null, 'No submitted answer');
        }

        const submittedAnswer = question_data.submitted_answer[name];

        callback(null, submittedAnswer);
    } catch (err) {
        return callback(null, 'inputNumberSubmittedAnswer render error: ' + err);
    }
};
