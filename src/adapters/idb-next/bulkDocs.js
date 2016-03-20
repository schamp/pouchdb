'use strict';

import { createError, REV_CONFLICT, MISSING_DOC } from '../../deps/errors';
import { parseDoc } from '../../deps/docs/parseDoc';
import merge from '../../deps/merge/index';

import { META_STORE, DOC_STORE, ATTACH_STORE } from './util';
import { idbError } from './util';

export default function(db, req, opts, callback) {

  var stores = [DOC_STORE, ATTACH_STORE, META_STORE];
  var txn = db.transaction(stores, 'readwrite');
  var results = [];

  function rootIsMissing(docInfo) {
    return docInfo.metadata.rev_tree[0].ids[1].status === 'missing';
  }

  // Reads the original doc from the store if available
  function fetchExistingDocs(txn, docs) {
    return new Promise(function (resolve) {
      var fetched = 0;
      var oldDocs = {};

      function readDone(e) {
        if (e.target.result) {
          oldDocs[e.target.result.id] = e.target.result;
        }
        if (++fetched === docs.length) {
          resolve(oldDocs);
        }
      }

      docs.forEach(function(doc) {
        txn.objectStore(DOC_STORE).get(doc.metadata.id).onsuccess = readDone;
      });
    });
  }

  function processDocs(txn, docs, oldDocs) {
    docs.forEach(function(doc, i) {
      var newDoc;

      // The first document write cannot be a deletion
      if ('was_delete' in opts && !(doc.metadata.id in oldDocs)) {
        newDoc = createError(MISSING_DOC, 'deleted');

      // Update the existing document
      } else if (doc.metadata.id in oldDocs) {
        newDoc = update(txn, doc, oldDocs[doc.metadata.id].metadata);

      // New document
      } else {
        newDoc = doc;
        newDoc.id = doc.metadata.id;
      }

      // First document write cannot have a revision
      // TODO: Pretty unclear implementation, revisit
      if (opts.new_edits && rootIsMissing(doc)) {
        newDoc = createError(REV_CONFLICT);
      }

      if (newDoc.error) {
        results[i] = newDoc;
      } else {
        write(txn, newDoc, i);
      }
    });
  }

  function update(txn, doc, previousDocMeta) {

    var previouslyDeleted = !!previousDocMeta.deleted;
    var deleted = !!doc.metadata.deleted;
    var isRoot = /^1-/.test(doc.metadata.rev);

    // Reattach first writes after a deletion to last deleted tree
    if (previouslyDeleted && !deleted && opts.new_edits && isRoot) {
      var tmp = doc.data;
      tmp._rev = previousDocMeta.rev;
      tmp._id = previousDocMeta.id;
      doc = parseDoc(tmp, opts.new_edits);
    }

    var merged = merge(previousDocMeta.rev_tree, doc.metadata.rev_tree[0], 100);

    doc.metadata.rev_tree = merged.tree;
    doc.id = doc.metadata.id;

    var inConflict = opts.new_edits && (((previouslyDeleted && deleted) ||
       (!previouslyDeleted && merged.conflicts !== 'new_leaf') ||
       (previouslyDeleted && !deleted && merged.conflicts === 'new_branch')));

    if (inConflict) {
      return createError(REV_CONFLICT);
    }

    return doc;
  }

  function write(txn, doc, i) {

    // We need to be able to check via an index whether a document
    // is deleted so encode as an int
    doc.metadata.deleted = doc.metadata.deleted ? 1 : 0;

    txn.objectStore(DOC_STORE).put(doc).onsuccess = function() {
      results[i] = {
        ok: true,
        id: doc.id,
        rev: doc.metadata.rev
      };
    };
  }

  var docs = [];
  for (var i = 0, len = req.docs.length; i < len; i++) {
    var result;
    // TODO: We should get rid of throwing for invalid docs, also not sure
    // why this is needed in idb-next and not idb
    try {
      result = parseDoc(req.docs[i], opts.new_edits);
    } catch (err) {
      result = err;
    }
    if (result.error) {
      return callback(result);
    }
    docs.push(result);
  }

  txn.onabort = idbError(callback);
  txn.ontimeout = idbError(callback);

  txn.oncomplete = function() {
    callback(null, results);
  };

  fetchExistingDocs(txn, docs).then(function(oldDocs) {
    processDocs(txn, docs, oldDocs);
  });
};
