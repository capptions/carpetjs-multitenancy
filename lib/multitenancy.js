'use strict';

const OVERRIDE = 'OVERRIDE_MULTITENANCY';

module.exports = $ => {

  const HISTORY_LIMIT = $.config.hasOwnProperty('history_limit') ? $.config.history_limit : 25;

  $.mongoose.multitenancy = {
    isRequest (req) {
      return req && typeof req === 'object' &&
        (req.hasOwnProperty('organizationId') || req.hasOwnProperty('originalMethod'));
    },

    modelFromScope (scope) {
      if (scope.modelName) {
        return scope;
      }
      else if (scope.constructor && scope.constructor.modelName) {
        return scope.constructor;
      }
      else if (scope.collectionName) {
        const models = $.mongoose.models;
        return models[Object.keys(models).find(name => models[name].collection === scope)];
      }
    },

    verify (schema, conditions) {
      if (!schema) {
        return;
      }

      if (Array.isArray(conditions)) {
        return conditions.forEach(c => $.mongoose.multitenancy.verify(schema, c));
      }

      /*
        If organizationId is part of the model:
          - enforce organizationId to exist query conditions
          - enforce organizationId to be a scalar
            (to prevent hijacking with { $exists: true } etc.)
       */

      if (!schema.paths) {
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

      const validOrganization = conditions.organization &&
        $.utils.isObjectId($.utils.getId(conditions.organization));
      const validOrganizations = conditions.organizations &&
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
    },

    injectBaseProperties (scope, req, doc, isUpdate) {
      if (!$.mongoose.multitenancy.isRequest(req)) {
        return;
      }

      if (req.userId) {
        doc.user_updated = $.mongoose.Types.ObjectId(req.userId);
        if (!isUpdate && !doc.user_created) {
          doc.user_created = $.mongoose.Types.ObjectId(req.userId);
        }
      }

      doc.update_spec = {
        timestamp: new Date(),
        app_name: req.appName || doc.app_name || '',
        organization: req.organizationId && $.mongoose.Types.ObjectId(req.organizationId),
        user: req.userId && $.mongoose.Types.ObjectId(req.userId)
      };

      const model = $.mongoose.multitenancy.modelFromScope(scope);
      const paths = (model && model.schema && model.schema.paths) || {};
      const historyFields = Object.keys(paths)
        .filter(field => paths[field].options && paths[field].options.history)
        .filter(field => (doc._original || {})[field] !== doc[field]);

      doc.history = [Object.assign({
        from: historyFields.reduce((from, field) => Object.assign(from, {
          [field]: (doc._original || {})[field]
        }), {}),
        to: historyFields.reduce((to, field) => Object.assign(to, {
          [field]: doc[field]
        }), {})
      }, doc.update_spec)];
    },

    injectProperties (scope, req, conditions, method) {
      const model = $.mongoose.multitenancy.modelFromScope(scope);
      $.mongoose.multitenancy.injectors.forEach(inj => inj(req, conditions, method, model));
    },

    injectors: [function organizationInjector(req, conditions, method, model) {
      if (conditions[OVERRIDE] || conditions.get && conditions.get(OVERRIDE)) {
        delete conditions[OVERRIDE];
        return;
      }

      const schema = model && model.schema;
      const paths = schema && schema.paths;

      if ($.mongoose.multitenancy.isRequest(req) && req.hasOwnProperty('organizationId') && paths) {
        if (!!schema.paths.organizations) {
          conditions.organizations = $.mongoose.Types.ObjectId(req.organizationId);
          if (method === 'insert') {
            conditions.organizations = [conditions.organizations];
          }
        }
        else if (!!schema.paths.organization) {
          conditions.organization = $.mongoose.Types.ObjectId(req.organizationId);
        }
      }

      return $.mongoose.multitenancy.verify(schema, conditions);
    }]
  };

  const stripRequest = args => {
    args = Array.prototype.slice.call(args, 0);

    if ($.mongoose.multitenancy.isRequest(args[0])) {
      args = args.slice(1);
    }

    return args;
  };

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
        ref: 'shared.User',
        index: true
      },
      user_updated: {
        type: $.mongoose.Schema.ObjectId,
        ref: 'shared.User'
      },
      history: [{
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
        },
        from: {},
        to: {}
      }],
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

  ['findOne', 'find'].forEach(key => {
    const original = $.mongoose.Model[key];
    $.mongoose.Model[key] = function (req, ...args) {
      if (!$.mongoose.multitenancy.isRequest(req)) {
        args.unshift(req);
      }

      $.mongoose.multitenancy.injectProperties(this, req, args[0] || {}, 'find');

      return original.apply(this, args);
    };
  });

  // Override query execution to check for organizationId
  ['findOne', 'find', 'exec'].forEach(key => {
    const original = $.mongoose.Query.prototype[key];
    $.mongoose.Query.prototype[key] = function (req, ...args) {
      if (!$.mongoose.multitenancy.isRequest(req)) {
        args.unshift(req);
      }

      const query = args[0];

      if (key === 'exec' || (query && typeof query === 'object' && Object.keys(query).length > 0)) {
        const conditions = Object.keys(this._conditions).length ?
          this._conditions :
          (this._mongooseOptions.conditions || query.conditions || query);

        const model = $.mongoose.multitenancy.modelFromScope(this);
        $.mongoose.multitenancy.verify(model && model.schema, conditions);
      }

      args[0] = query;

      return original.apply(this, args);
    };
  });

  const _remove = $.mongoose.Model.remove;
  $.mongoose.Model.remove = function (req, ...args) {
    if (!$.mongoose.multitenancy.isRequest(req)) {
      args.unshift(req);
    }

    $.mongoose.multitenancy.injectProperties(this, req, args[0], 'remove');

    return _remove.apply(this, args);
  };

  const _update = $.mongoose.Model.update;
  $.mongoose.Model.update = function (req, ...args) {
    if (!$.mongoose.multitenancy.isRequest(req)) {
      args.unshift(req);
    }

    $.mongoose.multitenancy.injectProperties(this, req, args[0], 'update');

    const id = args[0].organization;

    if (args[1] && args[1].organization && !$.utils.idEquals(args[1].organization, id)) {
      $.logging.error('Attempt to modify organizationId!', args[1].organization, id);
      throw new Error('bad_request');
    }

    if (args[1] && args[1].organizations && !$.utils.containsId(args[1].organizations, id)) {
      $.logging.error('Attempt to modify organizationId!', args[1].organizations, id);
      throw new Error('bad_request');
    }

    let doc = this;

    if ($.mongoose.multitenancy.isRequest(req) && args[1]) {
      doc = args[1].$set = args[1].$set || {};
    }

    $.mongoose.multitenancy.injectBaseProperties(this, req, doc, true);

    return _update.apply(this, args);
  };

  // Override findById methods
  ['findById', 'findByIdAndRemove', 'findByIdAndUpdate'].forEach(key => {
    $.mongoose.Model[key] = function (req, ...args) {
      if (!$.mongoose.multitenancy.isRequest(req)) {
        args.unshift(req);
      }

      args[0] = { _id: args[0] };


      $.mongoose.multitenancy.injectProperties(this, req, args[0], 'find');

      return this[key.replace('ById', 'One')].apply(this, args);
    };
  });

  const _save = $.mongoose.Model.prototype.save;
  $.mongoose.Model.prototype.save = function (req, ...args) {
    if (!$.mongoose.multitenancy.isRequest(req)) {
      args.unshift(req);
    }

    if (!this.isNew) {
      const allowedOrgs = $.utils.getId(this.organizations || []);
      if (this.isModified('organization') && !$.utils.containsId(allowedOrgs, this.organization)) {
        // Don't allow modification of organizationId
        this.organization = $.mongoose.Types.ObjectId(req.organizationId);
      }
    }

    $.mongoose.multitenancy.injectProperties(this, req, this, 'save');
    $.mongoose.multitenancy.injectBaseProperties(this, req, this, !this.isNew);

    return _save.apply(this, args);
  };

  // Override Count method
  const _count = $.mongoose.Model.count;
  $.mongoose.Model.count = function (req, ...args) {
    if (!$.mongoose.multitenancy.isRequest(req)) {
      args.unshift(req);
    }

    if (typeof args[0] === 'function') {
      args[1] = args[0];
      args[0] = {};
    }

    $.mongoose.multitenancy.injectProperties(this, req, args[0], 'count');

    return _count.apply(this, args);
  };

  // Override distinct method
  const _distinct = $.mongoose.Model.distinct;
  $.mongoose.Model.distinct = function (req, ...args) {
    if (!$.mongoose.multitenancy.isRequest(req)) {
      args.unshift(req);
    }

    if (typeof args[1] === 'function') {
      args[2] = args[1];
      args[1] = {};
    }

    $.mongoose.multitenancy.injectProperties(this, req, args[1], 'distinct');

    return _distinct.apply(this, args);
  };

  // Override Aggregate method
  const _aggregate = $.mongoose.Model.aggregate;
  $.mongoose.Model.aggregate = function (req, ...args) {
    if (!$.mongoose.multitenancy.isRequest(req)) {
      args.unshift(req);
    }

    let match = args[0];

    if (args.length) {
      if (Array.isArray(match)) { // Is an array of Operations
        if (!match.length || !match[0].$match) {
          match.unshift({ $match: {} });
        }

        match = match[0];
      }
      else if (!match.$match) {
        match = { $match: {} };
        args.unshift(match);
      }
    }
    else {
      match = { $match: {} };
      args.unshift(match);
    }

    $.mongoose.multitenancy.injectProperties(this, req, match.$match, 'aggregate');

    return _aggregate.apply(this, args);
  };

  // Override Insert method
  const _insert = $.mongoose.Collection.prototype.insert;
  $.mongoose.Collection.prototype.insert = function (req, ...args) {
    if (!$.mongoose.multitenancy.isRequest(req)) {
      args.unshift(req);
    }

    if ($.mongoose.multitenancy.isRequest(req)) {
      args[0] = args[0].map(doc => {
        $.mongoose.multitenancy.injectProperties(this, req, doc, 'insert');
        $.mongoose.multitenancy.injectBaseProperties(this, req, doc);
        return doc;
      });
    }

    return _insert.apply(this, args);
  };

  // Override Update method
  const _updateCollection = $.mongoose.Collection.prototype.update;
  $.mongoose.Collection.prototype.update = function (req, ...args) {
    if (!$.mongoose.multitenancy.isRequest(req)) {
      args.unshift(req);
    }

    // Since history isn't always populated, consider a single history entry as a push
    if (args[1] && args[1].$set && args[1].$set.history && args[1].$set.history.length === 1) {
      const model = $.mongoose.multitenancy.modelFromScope(this);
      const options = model && model.schema && model.schema.options;
      const limit = options && options.HISTORY_LIMIT || HISTORY_LIMIT;

      args[1].$push = Object.assign(args[1].$push || {}, {
        history: {
          $each: [args[1].$set.history[0]],
          $sort: { timestamp: -1 },
          $slice: limit
        }
      });

      delete args[1].$set.history;
    }

    return _updateCollection.apply(this, args);
  };

  const _schema = $.mongoose.Schema;
  $.mongoose.Schema = function () {
    _schema.apply(this, arguments);

    this.pre('save', function (next, req) {
      if ($.mongoose.multitenancy.isRequest(req)) {
        this._req = req;
        $.mongoose.multitenancy.injectProperties(this, req, this, 'save');
      }

      next();
    });
  };

  Object.keys(_schema).concat('prototype').forEach(key => $.mongoose.Schema[key] = _schema[key]);

  $.require('service').prototype.COMMIT_REQ = true;
  $.require('service').prototype.cache.reqFields = ['organizationId', 'userId'];
};
