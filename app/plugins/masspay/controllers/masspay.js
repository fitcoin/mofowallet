(function () {
'use strict';
var module = angular.module('fim.base');
module.controller('MasspayPluginController', function($scope, $rootScope, $timeout, $interval, plugins, nxt, $http, ngTableParams, $sce, modals, $q, db, $state, requests) {
  var PLUGIN = plugins.get('masspay');

  $scope.CREATING       = 'creating';
  $scope.PRUNING        = 'pruning';
  $scope.BROADCASTING   = 'broadcasting';
  $scope.COMPLETE       = 'complete';
  $scope.ALL_CONFIRMED  = 'all_confirmed';
  
  $scope.BROADCASTED    = 'broadcasted';
  $scope.UNCONFIRMED    = 'unconfirmed';
  $scope.CONFIRMED      = 'confirmed';

  $scope.initialized    = false;
  $scope.incomplete     = false;
  $scope.accountRS      = null;
  $scope.fileName       = null;
  $scope.secretPhrase   = null;
  $scope.fileContent    = null;
  $scope.feeNQT         = null;
  $scope.isBroadcasting = false;
  $scope.isCreating     = false;
  $scope.phase          = $scope.CREATING;
  $scope.statusCheckRemaining = 0;
  var api               = null;
  var engineType        = null;

  // podium used for everything but status
  var podium            = null;

  var statusTimeout     = null;
  $scope.$on('destroy', function () {
    $timeout.cancel(statusTimeout);
  });

  $scope.tableParams    = new ngTableParams({ page: 1, count: 10 }, {
    total: 0,
    getData: function($defer, params) {
      var offset = (params.page() - 1) * params.count();
      db.masspay_payments.orderBy('index').offset(offset).limit(params.count()).toArray().then(
        function (payments) {
          angular.forEach(payments, function (payment) {
            payment.amountNXT = payment.amountNXT||nxt.util.convertToNXT(payment.amountNQT);

            var parts = (payment.recipientRS||'').split(':');
            payment.id_rs = parts[0];
            payment.publicKey = parts[1];

            engineType = (payment.id_rs.indexOf('FIM-') == 0) ? 'TYPE_FIM' : 'TYPE_NXT';
            payment.engine_type = engineType;
            api = nxt.get(engineType);

            if (payment.transactionResult.length > 0) {
              payment.createdLabel = payment.transactionSuccess===true ? 'success' : 'failed';
            }
            else {
              payment.createdLabel = payment.created === 1;
            }

            if (payment.broadcastResult.length > 0) {
              payment.broadcastedLabel = payment.broadcastSuccess===true ? 'success' : 'undetermined';
            }
            else {
              payment.broadcastedLabel = payment.broadcasted === 1;
            }

            if (payment.blockchainStatus == $scope.CONFIRMED) {
              payment.blockchainLabel = 'confirmed';
              payment.blockchainIcon = 'fa fa-check';
            }
            else if (payment.blockchainStatus == $scope.UNCONFIRMED) {
              payment.blockchainLabel = 'unconfirmed';
              payment.blockchainIcon = 'fa fa-cog fa-spin';
            }
            else {
              payment.blockchainLabel = 'undetermined';
              payment.blockchainIcon = 'fa fa-exclamation-triangle';
            }
          });
          $defer.resolve(payments);
        }
      );
    }
  });

  /* On startup we check to see if the database is empty. 
     If it's not we continue where we left of the last time */
  db.masspay_payments.count().then(
    function (count) {
      if (count == 0) {
        $scope.$evalAsync(function () {
          $scope.initialized = false;
          $scope.incomplete  = false;
        });
      }
      else {
        $scope.$evalAsync(function () {
          $scope.initialized = true;
          $scope.incomplete  = true;
        });
      }

      $scope.tableParams.total(count);

      db.masspay_payments.addObserver($scope, {
        create: function (elements) {
          $scope.tableParams.total($scope.tableParams.total() + elements.length);
        },
        remove: function (elements) {
          $scope.tableParams.total($scope.tableParams.total() - elements.length);
        },
        finally: function () {
          $scope.$evalAsync(function () {
            $scope.tableParams.reload();   
          });          
        }
      });

      determinePhase();
    }
  );

  $scope.start = function () {
    modals.open('massPaySelectFile', {
      resolve: {
        items: function () { return {}; }
      },
      close: function (items) {
        $scope.$evalAsync(function () {
          $scope.initialized = true;
          $scope.fileName    = items.file.name;
          $scope.fileContent = items.fileContent;

          db.transaction('rw', db.masspay_payments, function () { db.masspay_payments.clear(); }).then(function () {
            loadFileContent(items.fileContent).then(
              function () {
                determinePhase();
              }
            );
          });              
        });
      }
    });
  }

  $scope.deletePayment = function (payment) {
    db.masspay_payments.delete(payment.id).then(
      function () {
        determinePhase();
      }
    );
  }

  $scope.retryBroadcastTransaction = function (payment) {
    broadcastTransaction(payment).then(
      function (data) {
        payment.update({
          blockchainStatus: $scope.BROADCASTED,
          transaction: data.transaction,
          broadcastResult: JSON.stringify(data),
          broadcastSuccess: true,
        });
      },
      function (data) {
        payment.update({
          broadcastResult: JSON.stringify(data),
          broadcastSuccess: false,
        });
      }
    );
  }

  $scope.inspect = function (object) {
    if (typeof object == 'string') {
      object = JSON.parse(object);
    }
    plugins.get('inspector').inspect({
      title: 'Payment Details',
      object: object
    });
  }

  $scope.continuePreviousRun = function () {
    $scope.$evalAsync(function () {
      $scope.fileName     = 'Continueing previous run';
      $scope.initialized  = true;
      $scope.incomplete   = false;
      determinePhase();
    });
  }

  $scope.startNewRun = function () {
    db.transaction('rw', db.masspay_payments, function () { db.masspay_payments.clear(); }).then(function () {
      $state.go($state.current, {}, {reload: true});
    });
  }

  $scope.startCreatingTransactions = function () {
    if (podium) { podium.destroy() }
    podium = requests.theater.createPodium('masspay', $scope);
    $scope.$evalAsync(function () {
      $scope.isCreating = true;
      createAllTransactions();
    });
  }

  $scope.stopCreatingTransactions = function () {
    podium.destroy();
    $scope.$evalAsync(function () {
      $scope.isCreating = false;
    });
  }

  $scope.startBroadcastingTransactions = function () {
    if (podium) { podium.destroy() }
    podium = requests.theater.createPodium('masspay', $scope);
    $scope.$evalAsync(function () {
      $scope.isBroadcasting = true;
      broadcastAllTransactions();
    });
  }

  $scope.stopBroadcastingTransactions = function () {
    podium.destroy();
    $scope.$evalAsync(function () {
      $scope.isBroadcasting = false;
    });
  }

  var countdownInterval = null;
  function scheduleBlockchainStatusCheck() {
    var delay = 15 * 1000;
    statusTimeout = $timeout($scope.checkBlockchainStatus, delay, false);
    
    var remaining = delay/1000;
    $interval.cancel(countdownInterval);
    countdownInterval = $interval(function () {
      $scope.$evalAsync(function () {
        $scope.statusCheckRemaining = remaining--;    
      })
    }, 1000, remaining, false);  
  }

  $scope.checkBlockchainStatus = function (force) {
    $interval.cancel(countdownInterval);
    $scope.$evalAsync(function () { 
      $scope.statusCheckRemaining = 0; 
      scheduleBlockchainStatusCheck();
    });

    var statusPodium = requests.theater.createPodium('masspay:status', $scope);
    db.masspay_payments.where('broadcasted').
                        equals(1).
                        and(function (p) { return p.blockchainStatus != $scope.CONFIRMED || force } ).
                        toArray().then(
      function (payments) {
        var promises = [];
        angular.forEach(payments, function (payment) {
          if (force) {
            payment.update({blockchainStatus: $scope.UNCONFIRMED });
          }
          promises.push(
            api.getTransaction({ fullHash: payment.fullHash }, { priority: 1, podium: statusPodium }).then(
              function (data) {
                payment.update({
                  blockchainStatus: data.block ? $scope.CONFIRMED : $scope.UNCONFIRMED
                });
              }
            )
          );
        });
        $q.all(promises).then(
          function () {
            determinePhase();
          }
        )
      }
    );
  }

  function broadcastAllTransactions() {
    db.masspay_payments.where('broadcasted').
                        equals(0).
                        toArray().then(
      function (payments) {
        var promises = [];
        angular.forEach(payments, function (payment) {
          var deferred = $q.defer();
          promises.push(deferred.promise);
          payment.update({broadcasted: 1}).then(
            function () {
              broadcastTransaction(payment).then(
                function (data) {
                  payment.update({
                    blockchainStatus: $scope.BROADCASTED,
                    transaction: data.transaction,
                    broadcastResult: JSON.stringify(data),
                    broadcastSuccess: true,
                  }).then(deferred.resolve, deferred.reject);
                },
                function (data) {
                  payment.update({
                    broadcastResult: JSON.stringify(data),
                    broadcastSuccess: false,
                  }).then(deferred.resolve, deferred.reject);
                }
              );
            },
            deferred.reject
          );
        });
        $q.all(promises).then(
          function () {
            $scope.$evalAsync(function () {
              $scope.isBroadcasting = false;
            });
            determinePhase();
          }
        );
      }
    );
  }

  function promptForSender() {
    var deferred = $q.defer();
    modals.open('secretPhrase', {
      resolve: {
        items: function () {
          return {
            engineType: engineType
          }
        }
      },
      close: function (items) {
        $scope.$evalAsync(function () {
          $scope.accountRS    = items.sender;
          $scope.secretPhrase = items.secretPhrase;
          $scope.feeNQT       = nxt.util.convertToNQT($scope.accountRS.indexOf('FIM-') == 0 ? 0.1 : 1);

          deferred.resolve();
        });        
      }
    });
    return deferred.promise;
  }

  function createAllTransactions() {    
    promptForSender().then(function () {
      db.masspay_payments.where('created').
                          equals(0).
                          toArray().then(
        function (payments) {
          var promises = [];
          angular.forEach(payments, function (payment) {
            var deferred = $q.defer();
            promises.push(deferred.promise);
            payment.update({created: 1}).then(
              function () {
                createTransaction(payment).then(
                  function (d) {
                    payment.update({
                      node_url: d.options.node_out.url,
                      node_id: d.options.node_out.id,
                      timestamp: nxt.util.formatTimestamp(d.data.transactionJSON.timestamp),
                      transactionBytes: d.data.transactionBytes,
                      fullHash: d.data.fullHash,
                      transactionResult: JSON.stringify(d.data),
                      transactionSuccess: true
                    }).then(deferred.resolve, deferred.reject);
                  },
                  function (d) {
                    payment.update({
                      transactionResult: JSON.stringify(d.data),
                      transactionSuccess: false
                    }).then(deferred.resolve, deferred.reject);
                  }
                );
              },
              deferred.reject
            );
          });
          $q.all(promises).then(
            function () {
              $scope.$evalAsync(function () {
                $scope.isCreating = false;
              });
              determinePhase();
            }
          );
        }
      );
    });
  }

  function broadcastTransaction(payment) {
    var deferred = $q.defer();
    db.nodes.where('id').equals(payment.node_id).first().then(
      function (node) {
        api.broadcastTransaction({ 
          transactionBytes: payment.transactionBytes 
        }, { 
          priority: 2, 
          podium: podium,
          node: node
        }).then(deferred.resolve, deferred.reject);
      }
    );
    return deferred.promise;
  }

  function createTransaction(payment) {
    var deferred = $q.defer();
    var args = {
      secretPhrase: $scope.secretPhrase,
      publicKey: api.crypto.secretPhraseToPublicKey($scope.secretPhrase),
      dontBroadcast: true,
      amountNQT: payment.amountNQT,
      feeNQT: $scope.feeNQT,
      deadline: String(payment.deadline),
    };

    if (payment.recipientRS.indexOf(':') == -1) {
      var recipientRS = payment.recipientRS;
      var recipientPublicKey = null;
    }
    else {
      var parts = payment.recipientRS.split(':');
      var recipientRS = parts[0];
      var recipientPublicKey = parts[1];
    }

    var address = api.createAddress();
    if (!address.set(recipientRS)) {
      deferred.reject({
        data: {
          errorDescription: 'Invalid address'
        }
      });
    }

    args.recipient = address.account_id();
    if (recipientPublicKey) {
      args.recipientPublicKey = recipientPublicKey;
    }

    if (payment.message && payment.message.length > 0) {
      if (payment.messageIsPublic === true) {
        args.public_message = true;         
      }
      else {
        args.encrypt_message = true;
      }
      args.message = payment.message;
    }

    function send() {
      var options = {priority: 3, podium: podium};
      api.sendMoney(args, options).then(
        function (data) {
          deferred.resolve({data:data, options:options});
        },
        function (data) {
          if (typeof data == 'string') {
            data = { error: data };
          }
          deferred.reject({data:data, options:options});
        }
      );
    }

    if (args.encrypt_message && !args.recipientPublicKey) {
      api.getAccountPublicKey({account:recipientRS}, {priority:5, podium: podium}).then(
        function (data) {
          args.recipientPublicKey = data.publicKey;
          send();
        },
        function (data) {
          if (typeof data == 'string') {
            data = { error: data };
          }
          deferred.reject({data:data, options:options});
        }
      );
    }
    else {
      send();
    }
    return deferred.promise;
  }

  /** 
   * Determines the process phase.
   *
   * CREATING is the phase when not all transactions have been created, either
   * successfully or not.
   *
   * PRUNING is the phase where all transactions are created but some have an
   * error status
   *
   * BROADCASTING is when all transactions are created and none have error status
   */
  function determinePhase() {
    db.masspay_payments.where('created').
                        equals(0).
                        count().then(
      function (count) {
        if (count > 0) {
          $scope.$evalAsync(function () { $scope.phase = $scope.CREATING });
        }
        else /* if (count == 0) */ {
          db.masspay_payments.where('created').
                    equals(1).
                    toArray().then(
            function (payments) {
              if (payments.length == 0) {
                $scope.$evalAsync(function () { $scope.phase = $scope.CREATING });
              }
              else {
                var payment;
                for (var i=0; i<payments.length; i++) {
                  payment = payments[i];
                  if (payment.transactionSuccess===false) {
                    $scope.$evalAsync(function () { $scope.phase = $scope.PRUNING });
                    return;
                  }
                }

                db.masspay_payments.where('broadcasted').
                    equals(0).
                    toArray().then(
                  function (non_broadcasted) {
                    if (non_broadcasted.length > 0) {
                      $scope.$evalAsync(function () { $scope.phase = $scope.BROADCASTING });
                    }
                    else {
                      db.masspay_payments.where('blockchainStatus').equals($scope.CONFIRMED).count().then(
                        function (confirmed_count) {
                          if (confirmed_count == payments.length) {
                            $scope.$evalAsync(function () { $scope.phase = $scope.ALL_CONFIRMED });
                          }
                          else {
                            scheduleBlockchainStatusCheck();
                            $scope.$evalAsync(function () { $scope.phase = $scope.COMPLETE });
                          }
                        }
                      );
                    }
                  }  
                );                
              }
            }
          );
        }
      }
    );
  }

  /** 
   * Two syntaxes are supported. The verbose and dense syntax.
   *
   * Verbose:
   * {
   *   "payments": [{
   *     "recipient": "FIM-XXXXX-YYYY-XXXX-ZZZZ",
   *     "amount": "200.3001",
   *     "message": "Hello I'm a message",
   *     "messageIsPublic": true
   *   }]
   * }
   *
   * Dense (allows for a more column like look):
   * [
   *   ["FIM-XXXXX-YYYY-XXXX-ZZZZ","200.3001","Hello I'm a message", true],
   *   ["FIM-OOOOI-YYYY-XXXX-ZZZZ","300.3001","Hello I'm also another message", false]
   * ]   
   */
  function loadFileContent(content) {
    var deferred = $q.defer();
    var obj = JSON.parse(content);
    if (Array.isArray(obj)) {
      db.transaction('rw', db.masspay_payments, function () {
        angular.forEach(obj, function (payment, index) {
          storeInDB(index, payment[0],payment[1],payment[2],!!payment[3]);
        });
      }).then(deferred.resolve).catch(deferred.reject);
    }
    else {
      db.transaction('rw', db.masspay_payments, function () {
        angular.forEach(obj.payments, function (payment, index) {
          storeInDB(index, payment.recipient,payment.amount,payment.message,!!payment.messageIsPublic);
        });
      }).then(deferred.resolve).catch(deferred.reject);
    }
    return deferred.promise;
  }

  function storeInDB(index, recipient, amountNXT, message, messageIsPublic) {
    db.masspay_payments.put({
      index: index,
      senderRS: $scope.accountRS,
      recipientRS: recipient,
      amountNQT: nxt.util.convertToNQT(amountNXT),
      deadline: 1440,
      message: message,
      messageIsPublic: messageIsPublic,
      transactionBytes: '',
      transactionResult: '',
      broadcastResult: '',
      created: 0,
      broadcasted: 0
    });
  }

})
})();