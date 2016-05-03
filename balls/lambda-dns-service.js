var TARGET_REGION = 'eu-west-1';
var ROUTE53_HOSTED_ZONE_ID = '/hostedzone/Z1NNQ9OFGWGOXI';
var TTL_SECONDS = 300;
var DOMAIN_NAME = 'tst.gmon.io';
var ROLE_TAG = 'role';

var AWS = require('aws-sdk');
var async = require('async');

// Log the config:
console.log('Domain-name: "' + DOMAIN_NAME + '"');
console.log('Role: "' + ROLE_TAG + '"');
console.log('TTL: "' + TTL_SECONDS + '"');
console.log('R53 Hosted-zone ID: "' + ROUTE53_HOSTED_ZONE_ID + '"');
console.log('AWS Region: "' + TARGET_REGION + '"');

// Handler:
exports.handler = function (event, context) {
    var asgMessage = JSON.parse(event.Records[0].Sns.Message);
    var asgName = asgMessage.AutoScalingGroupName;
    var asgEvent = asgMessage.Event;

    // console.log(asgEvent);
    if (asgEvent === "autoscaling:EC2_INSTANCE_LAUNCH" || asgEvent === "autoscaling:EC2_INSTANCE_TERMINATE") {
        console.log("Handling Launch/Terminate Event for " + asgName);

        async.waterfall(
            [
                // Get details about the autoscaling-group (instances, tags etc):
                function describeAutoscalingGroup(next) {
                    console.log("* Retrieving ASG details ...");
                    var autoscaling = new AWS.AutoScaling({region: TARGET_REGION});

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
                    var roleName = ""

                    // Search for our role-tag in the ASGs list of tags:
                    for (tag of autoScalingGroup.Tags) { 
                        if (tag.Key == ROLE_TAG) {
                            roleName = tag.Value;
                            break
                        }
                    }

                    // Make sure we found one:
                    if (roleName == "") {
                        next('ASG: ' + asgName + ' does not define a "' + ROLE_TAG + '" tag!');
                    } else {
                        console.log('  => Role-name: "' + roleName + '"');
                        next(null, roleName, autoScalingGroup);
                    }
                },
                // Build a list of running instances:
                function retrieveRunningInstanceIds(roleName, autoScalingGroup, next) {
                    // console.log(autoScalingGroup)
                    console.log("* Finding running instances ...");
                    var instanceIds = []

                    // Search for our role-tag in the ASGs list of tags:
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
                        next(null, roleName, instanceIds)
                    }
                },
                // Retrieve instance metadata (availability-zones, IP-addresses):
                function retrieveInstanceMetadata(roleName, instanceIds, next) {
                    // console.log(instanceIds)
                    console.log("* Getting instance metadata ...");
                    var ec2 = new AWS.EC2({region: TARGET_REGION});

                    // Describe the instances for this autoscaling group:
                    ec2.describeInstances(
                        {
                            DryRun: false,
                            InstanceIds: instanceIds
                        }, function(err, response) {
                            next(err, roleName, response.Reservations);
                        }
                    );
                },
                // Build DNS address-mappings:
                function buildAddressMappings(roleName, reservations, next) {
                    // console.log(reservations)
                    console.log("* Building address-mappings for DNS records ...");
                    var addressMappings = {}

                    // Search for our role-tag in the ASGs list of tags:
                    for (reservation of reservations) {

                        // Region-wide record:
                        regionWideName = roleName + '.' + TARGET_REGION + '.i.' + DOMAIN_NAME;
                        if (addressMappings.hasOwnProperty(regionWideName)) {
                            addressMappings[regionWideName].push({Value: reservation.Instances[0].PrivateIpAddress});
                        } else {
                            console.log('  => ' + regionWideName)
                            addressMappings[regionWideName] = [{Value: reservation.Instances[0].PrivateIpAddress}];
                        }

                        // Availability-zone-specific record:
                        availabilityZoneName = roleName + '.' + reservation.Instances[0].Placement.AvailabilityZone + '.i.' + DOMAIN_NAME;
                        if (addressMappings.hasOwnProperty(availabilityZoneName)) {
                            addressMappings[availabilityZoneName].push({Value: reservation.Instances[0].PrivateIpAddress});
                        } else {
                            console.log('  => ' + availabilityZoneName)
                            addressMappings[availabilityZoneName] = [{Value: reservation.Instances[0].PrivateIpAddress}];
                        }
                    }

                    next(null, addressMappings);
                },
                // Create DNS records in Route53:
                function createDNSRecords(addressMappings, next) {
                    // console.log(addressMappings)
                    console.log("* Creating DNS records ...");
                    var route53 = new AWS.Route53();
                    var changeResourceRecordSetsRequest = {
                        ChangeBatch: {
                            Changes: []
                        },
                        HostedZoneId: ROUTE53_HOSTED_ZONE_ID
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
        context.done("Unsupported ASG event: " + asgName, asgEvent);
    }
};