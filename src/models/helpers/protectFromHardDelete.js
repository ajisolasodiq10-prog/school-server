// Schema plugin: blocks accidental hard deletes so academic history is preserved.
// Records should be deactivated through their status field instead.
//
// A deliberate hard delete (tests, scripted clean-ups) is still possible by passing
// the option explicitly:  Model.deleteMany(filter, { allowHardDelete: true })
//
// Note: this guards Mongoose delete operations only. It cannot stop bulkWrite,
// the native driver, or tools such as MongoDB Compass.
export default function protectFromHardDelete(schema, { label = 'This' } = {}) {
  const message = `${label} records cannot be deleted because other records depend on them. Set the status to inactive instead.`;

  schema.pre(
    ['deleteOne', 'deleteMany', 'findOneAndDelete'],
    { document: false, query: true },
    function () {
      if (!this.getOptions().allowHardDelete) {
        throw new Error(message);
      }
    }
  );

  schema.pre('deleteOne', { document: true, query: false }, function () {
    throw new Error(message);
  });
}
