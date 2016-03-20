'use strict';

import { createError, MISSING_DOC } from '../../deps/errors';
import { META_STORE, DOC_STORE, ATTACH_STORE } from './util';

export default function(db, id, opts, callback) {

  // We may be given a transaction object to reuse, if not create one
  var txn = opts.ctx;
  if (!txn) {
    var stores = [DOC_STORE, ATTACH_STORE, META_STORE];
    txn = db.transaction(stores, 'readonly');
  }

  txn.objectStore(DOC_STORE).get(id).onsuccess = function (e) {

    var doc = e.target.result;

    if (!doc || (doc.metadata.deleted && !opts.rev)) {
      callback(createError(MISSING_DOC, 'missing'));
      return;
    }

    doc.data._id = doc.metadata.id;
    doc.data._rev = doc.metadata.rev;

    callback(null, {
      doc: doc.data,
      metadata: doc.metadata,
      ctx: txn
    });

  };
}
