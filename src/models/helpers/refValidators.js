import mongoose from 'mongoose';

// Validators that make sure a reference points to a real document that belongs to
// the SAME school as the document being saved. MongoDB has no foreign keys, so this
// stops one school's records from being linked to another school's records.
//
// They run on document validation (save / create / validate). They do not run for
// updateOne / findOneAndUpdate unless runValidators is used, so later services should
// load-and-save documents or validate references themselves.

const schoolIdOf = (doc) => (typeof doc?.get === 'function' ? doc.get('schoolId') : undefined);

// Single ObjectId reference. `filter` adds extra conditions, e.g. { role: 'student' }.
export const refInSameSchool = (modelName, filter = {}) => ({
  validator: async function (value) {
    if (value == null) return true; // required-ness is handled by `required`
    const schoolId = schoolIdOf(this);
    if (!schoolId) return true; // the missing schoolId is reported by its own validator
    const found = await mongoose.model(modelName).exists({ _id: value, schoolId, ...filter });
    return Boolean(found);
  },
  message: (props) => `${props.path} must reference an existing ${modelName} in the same school.`,
});

// Array of ObjectId references (every id must exist in the same school).
export const refsInSameSchool = (modelName, filter = {}) => ({
  validator: async function (values) {
    if (!Array.isArray(values) || values.length === 0) return true;
    const schoolId = schoolIdOf(this);
    if (!schoolId) return true;
    const ids = [...new Set(values.map(String))];
    const count = await mongoose
      .model(modelName)
      .countDocuments({ _id: { $in: ids }, schoolId, ...filter });
    return count === ids.length;
  },
  message: (props) => `${props.path} must only reference existing ${modelName} records in the same school.`,
});

// Rejects the same id appearing twice in an array.
export const noDuplicateIds = {
  validator: (values) => new Set((values || []).map(String)).size === (values || []).length,
  message: (props) => `${props.path} contains duplicate entries.`,
};
