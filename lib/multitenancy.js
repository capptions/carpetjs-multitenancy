'use strict';

module.exports = function ($) {

  $.mongoose.MultiTenantSchema = function MultiTenantSchema() {
    $.mongoose.BaseSchema.apply(this, arguments);

    if (!this.paths.organization && !this.paths.organizations) {
      this.add({
        organization: {
          type: $.mongoose.Schema.ObjectId,
          ref: 'shared.Organization',
          index: true
        }
      });
    }

    this.add({
      user_created: {
        type: $.mongoose.Schema.ObjectId,
        ref: 'shared.User'
      },
      user_updated: {
        type: $.mongoose.Schema.ObjectId,
        ref: 'shared.User'
      },
      update_spec: {
        timestamp: {
          type: Date,
          default: Date.now
        },
        organization: {
          type: $.mongoose.Schema.ObjectId,
          ref: 'shared.Organization'
        },
        user: {
          type: $.mongoose.Schema.ObjectId,
          ref: 'shared.User'
        },
        app_name: {
          type: String
        }
      }
    });
  };

  $.utils.inherits($.mongoose.MultiTenantSchema, $.mongoose.BaseSchema);

  /*
   * Ensures that organizationId is compulsory while querying or updating
   */

  var validRequest = function validRequest(req) {
    return req && typeof req === 'object' &&
      (req.hasOwnProperty('organizationId') || req.hasOwnProperty('originalMethod'));
  };

  var sansRequestArguments = function sansRequestArguments(args) {
    args = Array.prototype.slice.call(args, 0);
    if (validRequest(args[0])) {
      args = args.slice(1);
    }
    return args;
  };

  var getSchema = function () {
    var schema = this.schema || (this.model && this.model.schema);

    if (schema) {
      return schema;
    }
    else if (this.conn && this.conn.base && this.conn.base.models) {
      for (var m in this.conn.base.models) {
        if (this.conn.base.models[m].collection === this) {
          return this.conn.base.models[m].schema;
        }
      }
    }
  };

  var checkOrganizationId = function checkOrganizationId(schema, conditions) {

    if (Array.isArray(conditions)) {
      return conditions.forEach(function (c) {
        checkOrganizationId(schema, c);
      });
    }

    /*
      If organizationId is part of the model:
        - enforce organizationId to exist query conditions
        - enforce organizationId to be a scalar
          (to prevent hijacking with { $exists: true } etc.)
     */

    if (!schema || !schema.paths) {
      // TODO: find another way of checking if organizationId is necessary
      $.logging.error('Unsure if organizationId is required and was provided!', conditions);
      throw new Error('bad_request');
    }

    // Only check if organization is parth of this schema
    if (!schema.paths.organization) {
      return;
    }

    // Pass if only _id or only _id and organization are queried
    if (/(^|_id)(,inactive)?(,organizations?)?$/.test(Object.keys(conditions).sort().join())) {
      return;
    }

    // Exception for mongoose nested set who queries on only parentId
    if (/parentId$/.test(Object.keys(conditions).sort().join())) {
      return;
    }

    var validOrganization = conditions.organization &&
      $.utils.isObjectId($.utils.getId(conditions.organization));
    var validOrganizations = conditions.organizations &&
      $.utils.isObjectId($.utils.getId(conditions.organizations));

    // If organization is part of the query, let it pass
    if (validOrganization) {
      return;
    }

    // If organizations is part of the schema, let that be a valid parameter
    if (!!schema.paths.organizations && validOrganizations) {
      return;
    }

    $.logging.error('No organizationId provided where required!', conditions);
    throw new Error('bad_request');
  };

  var attachOrganizationId = function attachOrganizationId(req, conditions) {
    var schema = getSchema.call(this);

    if (conditions.OVERRIDE_MULTITENANCY) {
      delete conditions.OVERRIDE_MULTITENANCY;
      return;
    }

    if (validRequest(req) && req.hasOwnProperty('organizationId') && schema && schema.paths) {
      if (!!schema.paths.organizations) {
        conditions.organizations = $.mongoose.Types.ObjectId(req.organizationId);
      }
      else if (!!schema.paths.organization) {
        conditions.organization = $.mongoose.Types.ObjectId(req.organizationId);
      }
    }
    checkOrganizationId(schema, conditions);
  };

  var attachBaseProperties = function attachBaseProperties(req) {

    if (!validRequest(req)) {
      return;
    }

    if (req.userId) {
      this.user_updated = $.mongoose.Types.ObjectId(req.userId);
      if (!this.user_created) {
        this.user_created = $.mongoose.Types.ObjectId(req.userId);
      }
    }

    this.update_spec = {
      timestamp: Date.now(),
      app_name: req.appName || this.app_name || '',
      organization: req.organizationId && $.mongoose.Types.ObjectId(req.organizationId),
      user: req.userId && $.mongoose.Types.ObjectId(req.userId)
    };

  };

  ['findOne', 'find'].forEach(function (key) {
    var original = $.mongoose.Model[key];
    $.mongoose.Model[key] = function (req) {
      var args = sansRequestArguments(arguments);

      args[0] = args[0] || {};

      attachOrganizationId.call(this, req, args[0]);

      return original.apply(this, args);
    };
  });

  // Override query execution to check for organizationId
  ['findOne', 'find', 'exec'].forEach(function (key) {
    var original = $.mongoose.Query.prototype[key];
    $.mongoose.Query.prototype[key] = function () {
      var args = sansRequestArguments(arguments);
      var query = args[0];

      if (key === 'exec' || (query && typeof query === 'object' && Object.keys(query).length > 0)) {
        var conditions = Object.keys(this._conditions).length ?
              this._conditions : (this._mongooseOptions.conditions || query.conditions || query);

        var schema = this.schema || this.model && this.model.schema;
        if (schema) {
          checkOrganizationId(schema, conditions);
        }
      }

      args[0] = query;
      return original.apply(this, args);
    };
  });

  var _remove = $.mongoose.Model.remove;
  $.mongoose.Model.remove = function (req) {
    var args = sansRequestArguments(arguments);

    attachOrganizationId.call(this, req, args[0]);

    return _remove.apply(this, args);
  };

  var _update = $.mongoose.Model.update;
  $.mongoose.Model.update = function (req) {
    var args = sansRequestArguments(arguments);

    attachOrganizationId.call(this, req, args[0]);
    var orgId = args[0].organization;

    if (args[1] && args[1].organization && !$.utils.idEquals(args[1].organization, orgId)) {
      $.logging.error('Attempt to modify organizationId!', args[1].organization, orgId);
      throw new Error('bad_request');
    }

    var self = this;
    if (validRequest(req) && args[1]) {
      self = args[1].$set = args[1].$set || {};
    }
    attachBaseProperties.call(self, req);

    return _update.apply(this, args);
  };

  // Override findById methods
  ['findById', 'findByIdAndRemove', 'findByIdAndUpdate'].forEach(function (key) {
    $.mongoose.Model[key] = function (req) {
      /*
        If organizationId is part of the model:
          - assume the first argument to be an organizationId
          - modify the arguments and use the matching findOne method
       */

      var args = sansRequestArguments(arguments);

      args[0] = { _id: args[0] };

      if (validRequest(req)) {
        attachOrganizationId.call(this, req, args[0]);
      }

      return this[key.replace('ById', 'One')].apply(this, args);
    };
  });

  var _save = $.mongoose.Model.prototype.save;
  $.mongoose.Model.prototype.save = function (req) {
    var args = sansRequestArguments(arguments);

    if (!this.isNew) {
      var allowedOrgs = $.utils.getId(this.organizations || []);
      if (this.isModified('organization') && !$.utils.containsId(allowedOrgs, this.organization)) {
        // Don't allow modification of organizationId
        this.organization = $.mongoose.Types.ObjectId(req.organizationId);
      }
    }

    attachOrganizationId.call(this, req, this);
    attachBaseProperties.call(this, req);

    return _save.apply(this, args);
  };

  // Override Count method
  var _count = $.mongoose.Model.count;
  $.mongoose.Model.count = function (req) {
    var args = sansRequestArguments(arguments);

    if (typeof args[0] === 'function') {
      args[1] = args[0];
      args[0] = {};
    }

    attachOrganizationId.call(this, req, args[0]);

    return _count.apply(this, args);
  };

  // Override distinct method
  var _distinct = $.mongoose.Model.distinct;
  $.mongoose.Model.distinct = function (req) {
    var args = sansRequestArguments(arguments);

    if (typeof args[1] === 'function') {
      args[2] = args[1];
      args[1] = {};
    }

    attachOrganizationId.call(this, req, args[1]);

    return _distinct.apply(this, args);
  };

  // Override Aggregate method
  var _aggregate = $.mongoose.Model.aggregate;
  $.mongoose.Model.aggregate = function (req) {
    var args = sansRequestArguments(arguments);

    if (args.length) {
      var firstOp = args[0];

      if (Array.isArray(firstOp)) { // Is an array of Operations
        if (!firstOp.length || !firstOp[0].$match) {
          firstOp.unshift({ $match: {} });
        }

        attachOrganizationId.call(this, req, firstOp[0].$match);
        args[0] = firstOp;
      }
      else if (!firstOp.$match) {
        args.unshift({ $match: {} });
        attachOrganizationId.call(this, req, args[0].$match);
      }
    }
    else {
      args.unshift({ $match: {} });
      attachOrganizationId.call(this, req, args[0].$match);
    }

    return _aggregate.apply(this, args);
  };

  // Override Insert method
  var _insert = $.mongoose.Collection.prototype.insert;
  $.mongoose.Collection.prototype.insert = function (req) {
    var self = this;
    var args = sansRequestArguments(arguments);

    if (validRequest(req)) {
      args[0] = args[0].map(function (doc) {
        attachOrganizationId.call(self, req, doc);
        attachBaseProperties.call(doc, req);
        return doc;
      });
    }

    return _insert.apply(this, args);
  };

  var _schema = $.mongoose.Schema;
  $.mongoose.Schema = function () {
    _schema.apply(this, arguments);
    this.pre('save', function (next, req) {
      if (validRequest(req)) {
        this._req = req;
        attachOrganizationId.call(this, req, this);
      }
      next();
    });
    this.post('init', function (doc) {
      doc._original = doc.toObject();
    });
  };

  Object.keys(_schema).concat('prototype').forEach(function (key) {
    $.mongoose.Schema[key] = _schema[key];
  });

  var baseService = $.require('service');
  baseService.prototype.COMMIT_REQ = true;

};
