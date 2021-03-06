// Define some tag-names:
var ROLE_TAG = 'role';
var ROUTE53_DOMAIN_NAME_TAG = 'r53-domain-name';
var ROUTE53_ZONE_ID_TAG = 'r53-zone-id';
var TTL_SECONDS = 300;

// Handler:
exports.handler = function (event, context) {
    // Log the raw "event":
    console.log(JSON.stringify(event));

    // Log the config:
    console.log('R53 Domain-name tag: "' + ROUTE53_DOMAIN_NAME_TAG + '"');
    console.log('R53 Hosted-zone ID tag: "' + ROUTE53_ZONE_ID_TAG + '"');
    console.log('Role tag: "' + ROLE_TAG + '"');
    console.log('TTL: "' + TTL_SECONDS + '"');

    var AWS = require('aws-sdk');
    var async = require('async');

    // Try to execute on every event we've been given:
    for (eventRecord of event.Records) { 

        var asgMessage = JSON.parse(eventRecord.Sns.Message);
        var asgEvent = asgMessage.Event;
        var asgName = asgMessage.AutoScalingGroupName;
        var asgRegion = 'eu-west-1'

        // Run if we're processing a launch or terminate event:
        if (asgEvent === "autoscaling:EC2_INSTANCE_LAUNCH" || asgEvent === "autoscaling:EC2_INSTANCE_TERMINATE") {
            console.log("Handling " + asgEvent + " Event for " + asgName);

            async.waterfall(
                [
                    // Get details about the autoscaling-group (instances, tags etc):
                    function describeAutoscalingGroup(next) {
                        console.log("* Retrieving ASG details ...");
                        var autoscaling = new AWS.AutoScaling({region: asgRegion});

                        // Look up the autoscaling group:
                        autoscaling.describeAutoScalingGroups(
                            {
                                AutoScalingGroupNames: [asgName],
                                MaxRecords: 1
                            }, function(err, response) {
                                if (response.AutoScalingGroups.length == 0) {
                                    next('Unable to find autoscaling group "' + asgName + '"!')
                                } else {
                                    next(err, response.AutoScalingGroups[0]);
                                }
                            }
                        );
                    },
                    // Make sure we got a role-tag:
                    function processTags(autoScalingGroup, next) {
                        // console.log(autoScalingGroup)
                        console.log("* Processing ASG tags ...");
                        var route53MetaData = {}

                        // Search for our role-tag in the ASGs list of tags:
                        for (tag of autoScalingGroup.Tags) { 
                            if (tag.Key == ROLE_TAG) {
                                route53MetaData.role = tag.Value;
                                console.log('  => Role-name: "' + route53MetaData.role + '"');
                            } else if (tag.Key == ROUTE53_DOMAIN_NAME_TAG) {
                                route53MetaData.domainName = tag.Value;
                                console.log('  => R53 domain-name: "' + route53MetaData.domainName + '"');
                            } else if (tag.Key == ROUTE53_ZONE_ID_TAG) {
                                route53MetaData.zoneId = tag.Value;
                                console.log('  => R53 zone-ID: "' + route53MetaData.zoneId + '"');
                            }
                        }

                        // Make sure we found one:
                        if (route53MetaData.role == "") {
                            next('ASG: ' + asgName + ' does not define a "' + ROLE_TAG + '" tag!');
                        } else if (route53MetaData.domainName == "") {
                            next('ASG: ' + asgName + ' does not define a "' + ROUTE53_DOMAIN_NAME_TAG + '" tag!');
                        } else if (route53MetaData.zoneId == "") {
                            next('ASG: ' + asgName + ' does not define a "' + ROUTE53_ZONE_ID_TAG + '" tag!');
                        }

                        next(null, route53MetaData, autoScalingGroup);
                    },
                    // Build a list of running instances:
                    function retrieveRunningInstanceIds(route53MetaData, autoScalingGroup, next) {
                        // console.log(autoScalingGroup)
                        console.log("* Finding running instances ...");
                        var instanceIds = []

                        // Find instances which are running:
                        for (instance of autoScalingGroup.Instances) { 
                            if (instance.LifecycleState == "InService") {
                                instanceIds.push(instance.InstanceId);
                            }
                        }

                        // Make sure we found some running instances:
                        if (instanceIds.length == 0) {
                            next('No running instances were found!')
                        } else {
                            console.log('  => Running instances (' + instanceIds.length + '): ' + instanceIds);
                            next(null, route53MetaData, instanceIds)
                        }
                    },
                    // Retrieve instance metadata (availability-zones, IP-addresses):
                    function retrieveInstanceMetadata(route53MetaData, instanceIds, next) {
                        // console.log(instanceIds)
                        console.log("* Getting instance metadata ...");
                        var ec2 = new AWS.EC2({region: asgRegion});

                        // Describe the instances for this autoscaling group:
                        ec2.describeInstances(
                            {
                                DryRun: false,
                                InstanceIds: instanceIds
                            }, function(err, response) {
                                next(err, route53MetaData, response.Reservations);
                            }
                        );
                    },
                    // Build DNS address-mappings:
                    function buildAddressMappings(route53MetaData, reservations, next) {
                        // console.log(reservations)
                        console.log("* Building address-mappings for DNS records ...");
                        var addressMappings = {}

                        // Search for our role-tag in the ASGs list of tags:
                        for (reservation of reservations) {

                            // Region-wide record:
                            regionWideName = route53MetaData.role + '.' + asgRegion + '.i.' + route53MetaData.domainName;
                            if (addressMappings.hasOwnProperty(regionWideName)) {
                                addressMappings[regionWideName].push({Value: reservation.Instances[0].PrivateIpAddress});
                            } else {
                                console.log('  => ' + regionWideName)
                                addressMappings[regionWideName] = [{Value: reservation.Instances[0].PrivateIpAddress}];
                            }

                            // Availability-zone-specific record:
                            availabilityZoneName = route53MetaData.role + '.' + reservation.Instances[0].Placement.AvailabilityZone + '.i.' + route53MetaData.domainName;
                            if (addressMappings.hasOwnProperty(availabilityZoneName)) {
                                addressMappings[availabilityZoneName].push({Value: reservation.Instances[0].PrivateIpAddress});
                            } else {
                                console.log('  => ' + availabilityZoneName)
                                addressMappings[availabilityZoneName] = [{Value: reservation.Instances[0].PrivateIpAddress}];
                            }
                        }

                        next(null, route53MetaData, addressMappings);
                    },
                    // Create DNS records in Route53:
                    function createDNSRecords(route53MetaData, addressMappings, next) {
                        // console.log(addressMappings)
                        console.log("* Creating DNS records ...");
                        var route53 = new AWS.Route53();
                        var changeResourceRecordSetsRequest = {
                            ChangeBatch: {
                                Changes: []
                            },
                            HostedZoneId: route53MetaData.zoneId
                        }

                        // Iterate through all of the record-names in addressMappings:
                        Object.keys(addressMappings).forEach(function (recordName) { 
                            var recordValue = addressMappings[recordName];
                            console.log('  => ' + recordName + ' = ' + recordValue);

                            // Add a change to the changeBatch:
                            changeResourceRecordSetsRequest.ChangeBatch.Changes.push(
                                {
                                    Action: 'UPSERT',
                                    ResourceRecordSet: {
                                        Name: recordName,
                                        Type: 'A',
                                        TTL: TTL_SECONDS,
                                        ResourceRecords: recordValue
                                    }
                                }
                            );

                        });

                        // Submit the changeResourceRecordSets() request to Route53:
                        route53.changeResourceRecordSets(changeResourceRecordSetsRequest, next);
                    }
                ], function (err) {
                  if (err) {
                    console.error('Unable to update DNS for an autoscaling event: ', err);
                  } else {
                    console.log("DNS has been updated for an autoscaling event");
                  }
                  context.done(err);
                }
            )
        } else {
            console.log("Unsupported ASG event: " + asgName, asgEvent);
        }
    }
    console.log("Finished");
};